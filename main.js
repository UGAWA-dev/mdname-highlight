/* mdName Highlight - Obsidian プラグイン
 * txt2mdp の mdName 書式 (Markdown ベースのネーム書式) を文字色でハイライトする。
 * mdName は素の Markdown なので、通常ノートを誤って着色しないよう
 * 「ページ見出し (## p.001 形式) を含む .md」だけを対象に自動判定する (設定不要)。
 * 配色は txtName Highlight と同じ (台詞=緑 / テロップ=紫 / 注釈=橙 / 発話者=青灰 /
 * 見出し=基本色 / ト書き・地の文=グレー / 分岐=シアン / ÷÷÷÷ 以降=薄字)。
 * 文字色のみで背景は付けない。
 *
 * ビルド不要の素の JavaScript (CommonJS)。txtname-highlight と同じ方式
 * (CodeMirror 6 の行デコレーション)。両プラグインは共存できる (対象拡張子が違う)。
 */
"use strict";

const { Plugin, editorInfoField, EditorSuggest, PluginSettingTab, Setting, Notice,
	SuggestModal, Modal } = require("obsidian");

/* ---- プラグイン設定 (サジェスト呼び出しキーの On/Off) ---- */
const DEFAULT_SETTINGS = {
	suggestTab: true,       // Tab (タブ文字) で記法サジェストを開く
	// **Shift+Tab で発話者候補 (speakers.md) を開く**。
	// 以前は `\` ＼ ¥ ￥ の文字で開いていたが、**iPadOS / macOS の日本語入力で
	// 変換候補が出て扱いにくい**ため打鍵へ変えた (2026-08-06・ユーザー要望)。
	suggestShiftTab: true,
};
const { ViewPlugin, Decoration, keymap } = require("@codemirror/view");
const { RangeSetBuilder, Prec } = require("@codemirror/state");

/* ---- mdName 文書の判定 ---- */
// ページ見出し ## p.001 (全角 ｐ．００１ も可) を含むかどうかで mdName と判定する
const MDNAME_DETECT_RE = /^##\s*[pPｐＰ][.．][0-9０-９]/m;
// 判定のための走査上限 (先頭からこのバイト数まで。原稿はページ見出しが早々に現れる)
const DETECT_SLICE = 20000;

/* ---- 行種別の判定パターン ---- */
const SCENE_RE = /^###\s/;             // ### 柱書き (ト書きと同じグレーにする)
const HEADING_RE = /^#{1,2}\s/;        // # 話数 / ## ページ
const SPEAKER_RE = /^\*\*[^*]+\*\*[ \t]*$/; // **発話者[@所属][:acting]** のみの行 (後ろの空白は半角空白とタブだけ。全角空白が付けば発話者ではない)
const TELOP_RE = /^\*\*\*.+\*\*\*$/;    // ***テロップ*** のみの行 (trim 済みに適用)
const ANNOT_RE = /^[{｛].*[}｝]$/;       // {注釈}
const DIRECTION_RE = /^[-*+]\s/;        // - ト書き (Markdown の箇条書き記号 * + も可)
const BRANCH_PROMPT_RE = /^0\.\s/;      // 0. 分岐の導入文
const BRANCH_CHOICE_RE = /^[1-9]\d*\.\s/; // 1. 2. ... 分岐の選択肢
// ルビ <...> (エスケープ << >> は除外)。m[1]=直前の1文字(または行頭), m[2]=<...>
const RUBY_RE = /(^|[^<])(<[^<>]+>)(?!>)/g;
// 厳密なルビ指定 |base<reading>| 。前後の | も淡色化する (中の <reading> は RUBY_RE が拾う)
const RUBY_PIPE_RE = /\|[^|<>]*<[^<>]+>\|/g;

/* 淡色化する範囲 (ルビの <...> と、厳密指定 |...<...>| の前後の |) を text から集めて
 * {start, end} (text 内の相対位置) の配列で返す。start 昇順・非重複。編集/閲覧で共用。 */
function collectRubyRanges(text) {
	const ranges = [];
	let m;
	RUBY_PIPE_RE.lastIndex = 0;
	while ((m = RUBY_PIPE_RE.exec(text)) !== null) {
		ranges.push({ start: m.index, end: m.index + 1 });                       // 開き |
		ranges.push({ start: m.index + m[0].length - 1, end: m.index + m[0].length }); // 閉じ |
	}
	RUBY_RE.lastIndex = 0;
	while ((m = RUBY_RE.exec(text)) !== null) {
		const s = m.index + m[1].length;  // 直前の1文字を除いた < の位置
		ranges.push({ start: s, end: s + m[2].length });
	}
	ranges.sort((a, b) => a.start - b.start);
	return ranges;
}

/* 台詞/テロップ行の中のルビ (<...> と |...| ) を薄色のマークにする */
function addRubyMarks(builder, line) {
	const ranges = collectRubyRanges(line.text);
	for (const r of ranges) {
		if (r.start === 0) {
			continue; // 行頭は行デコレーションと同一位置になり並び順制約に反するため避ける
		}
		builder.add(line.from + r.start, line.from + r.end,
			Decoration.mark({ class: "mdname-ruby" }));
	}
}

/* ---- 原稿の外側: コードフェンスとページ id の重複 (name-spec MDNAME.md §1・§3) ----
 * 正は corpus/body_corpus.json (2026-10-01・ユーザー判断)。**どちらも 1 行ずつ見る判定では
 * 決まらない** (前の行の状態で変わる) ので、**原稿全体を 1 回走査する純関数**にした。
 * 着色・波線・行 ID の 3 か所が同じ答えを使う (別々に書くと片方だけ古くなる)。 */

/* 行頭の半角空白とタブを削って ``` で始まる行がフェンスの印。**`>` の後ろの ``` は台詞の本文**
 * (印ではない)。`~~~` はフェンスとして扱わない。 */
const FENCE_RE = /^[ \t]*```/;

/* ---- ファイルと空白 (name-spec MDNAME.md §1・§4・2026-10-03 作者判断) ----
 * **先頭の BOM (U+FEFF) は原稿に含めない** (文中の U+FEFF は本文)。**改行は LF・CRLF・単独の CR のどれも行の区切り**。
 * **印の前後で削るのは半角空白とタブだけ** (ページ見出し・フェンス・分岐行と同じ)。全角空白などが前後に付いた行は
 * その種類の行ではなく**印の無い行**になり、印の無い行は要素にしない。**`trim()` は全角空白も NBSP も BOM も削る
 * ので、印の判定には使わない** (空行かどうかを見るだけなら使ってよい)。 */

/* 原稿を行に分ける: 先頭の BOM を外し、CRLF・単独の CR を LF にそろえてから "\n" で分ける */
function splitLinesOf(text) {
	return String(text).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/* 印を見るための行: 前後の半角空白とタブだけを削る (行末の CR も落とす。閲覧ビューの行は CR が残りうる) */
function markOf(raw) {
	return String(raw).replace(/\r$/, "").replace(/^[ \t]+|[ \t]+$/g, "");
}

/* 各行が「フェンスの中」か (開く行・閉じる行を含む)。lines は行の配列 (0 始まり)。
 * from: 走査を始める行 (0 始まり。省略は先頭)。**frontmatter の中の ``` は本文のフェンスにしない**
 * (先頭の frontmatter は原稿ではない。name-spec db7a9db・MDNAME.md §1)。
 * 戻り値: { inside: [bool], unclosedAt: 閉じていないフェンスを開いた行 (無ければ -1) }
 * **閉じていなければ最後まで原稿ではない** (誤り)。 */
function fenceMapOf(lines, from) {
	var inside = new Array(lines.length);
	var open = -1;
	for (var i = 0; i < lines.length; i++) {
		if (i < (from || 0)) {
			inside[i] = false;   // 走査の前 (frontmatter など) は見ない
			continue;
		}
		var isMark = FENCE_RE.test(lines[i]);
		if (open < 0) {
			if (isMark) {
				open = i;
				inside[i] = true;
			} else {
				inside[i] = false;
			}
		} else {
			inside[i] = true;
			if (isMark) {
				open = -1;   // 閉じた (この行も中に含む)
			}
		}
	}
	return { inside: inside, unclosedAt: open };
}

/* 閉じていないフェンスの**波線を付ける行** (0 始まり)。unclosedAt < 0 なら -1。
 * **開いた行そのものには付けない。** Obsidian の Live Preview は、カーソルが無い間
 * フェンスの ``` の行を**ほとんど潰して**描くので、波線が上半分しか見えなかった
 * (実機で作者が確認。波線は付いているが、読めない)。代わりに、開いた後の**最初の空でない行**
 * に付ける。**空行には付けない** (下線を引く文字が無く、見えない)。そのような行が無い
 * (フェンスが最終行など) ときだけ、開いた行に付ける。 */
function unclosedFenceWarnLine(lines, unclosedAt) {
	if (unclosedAt < 0) {
		return -1;
	}
	for (var i = unclosedAt + 1; i < lines.length; i++) {
		if (lines[i].trim() !== "") {
			return i;
		}
	}
	return unclosedAt;
}

/* ページ id が**文字列として同じ**ページ見出しの、2 つ目以降の行番号の集合 (0 始まり)。
 * `p.001` と `p.01` は別の id。**フェンスの中の見出しは数えない**。
 * p.002-003 と p.003 のようにページ番号が重なるものは縛らない (文字列が違うので)。 */
function duplicatePageLines(lines, inside) {
	var seen = {};
	var dup = {};
	for (var i = 0; i < lines.length; i++) {
		if (inside[i]) {
			continue;
		}
		var id = pageHeadingId(lines[i]);
		if (id === null) {
			continue;
		}
		if (Object.prototype.hasOwnProperty.call(seen, id)) {
			dup[i] = true;
		} else {
			seen[id] = true;
		}
	}
	return dup;
}

/* **÷÷÷÷ の行** (0 始まり)。無ければ lines.length。**フェンスの中の ÷÷÷÷ は数えない**
 * (name-spec 3078bd5: フェンスを ÷÷÷÷ より先に見る)。from 以降だけを見る (frontmatter の外)。 */
function cutLineOf(lines, inside, from) {
	for (var i = from; i < lines.length; i++) {
		if (!inside[i] && markOf(lines[i]).indexOf("÷÷÷÷") === 0) {
			return i;
		}
	}
	return lines.length;
}

/* **発話者の有効性** (name-spec MDNAME.md §4.2・2026-10-01 作者判断)。
 * 発話者の行は、**次に来る行が台詞 (`>`) のときだけ有効**。**飛ばすのは、空行・行 ID・cmd・
 * コメント (`<!-- … -->` の 1 行) だけ** (仕様が列挙した行。**これ以外は飛ばさない**)。
 * 有効な発話者は後に続く台詞に付くが、**この実装は台詞の本文も発話者の名前も持たない**ので、
 * 見るのは**有効か無効か**だけ。**無効な発話者の行は本文にならない** (作者に知らせる)。
 * **編集ビュー・閲覧ビューの着色と、発話者の登録、波線の知らせが同じ答えを使う** (別々に書くと
 * 食い違う —— 以前は編集ビューが「直後の行」、閲覧ビューが「空行を飛ばした次の行」、登録が
 * 「直後の行」で、**機能ごとに違った**)。
 *
 * **コードフェンスの行も飛ばさない** (name-spec b231511・2026-10-02 作者判断)。発話者の次が
 * フェンスの開始行なら、その行が「次に来る行」で、`>` ではないので**無効** (後ろに台詞があっても
 * 付けない)。以前は「フェンスの中は原稿ではないので飛ばす」と安全側に倒していたが、仕様は
 * 飛ばす行を列挙した文面どおりにした (複数行のコメントを飛ばさないのとも揃う。txt2mdp と
 * この実装がフェンスごと飛ばしていて、4 実装が 2 対 2 に割れていた)。
 * フェンスの開始行が先に来るので、**フェンスの中の行に到達することは無い** (中の `>` で
 * 有効にならない)。
 *
 * 引数: lines (0 始まり)・idx (発話者の行)・stop (÷÷÷÷ の行。無ければ lines.length)。
 * 戻り値: 次に来る行の番号 (飛ばさない行。**無ければ -1**)。 */
const COMMENT_LINE_RE = /^<!--.*-->$/;
function nextManuscriptLine(lines, idx, stop) {
	for (var i = idx + 1; i < stop; i++) {
		var m = markOf(lines[i]);
		// 空行かどうかは trim() で見る (全角空白だけの行も空行として飛ばす。仕様もコーパスも縛っていない)。
		// 印 (行 ID・指示・コメント) は半角空白とタブだけ削って見る
		if (lines[i].trim() === "" || ID_LINE_RE.test(m) || CMD_LINE_RE.test(m) || COMMENT_LINE_RE.test(m)) {
			continue;
		}
		return i;
	}
	return -1;
}

/* 発話者の行が有効か (次に来る行が台詞のとき)。無効なら、**判定を決めた行** (次に来る行。無ければ
 * 原稿の終わり) も返す —— 波線を出すかどうかの判断 (打っている最中か) に使う。
 * 戻り値: { valid: bool, decidedAt: 判定を決めた行 (0 始まり。次に来る行が無ければ -1) } */
function speakerValidity(lines, idx, stop) {
	var next = nextManuscriptLine(lines, idx, stop);
	if (next < 0) {
		return { valid: false, decidedAt: -1 };
	}
	return { valid: markOf(lines[next]).indexOf(">") === 0, decidedAt: next };
}

/* **閲覧ビュー用**: 行の配列だけから、発話者の行 (idx) の有効性を求める。閲覧ビューは 1 ブロック
 * ずつ描くので、フェンスの中と ÷÷÷÷ の位置をその場で求める (編集ビューは全体を 1 回走査して
 * 使い回す)。**どちらも speakerValidity を使うので、有効か無効かは同じ答えになる** (以前は
 * 編集ビューが「直後の行」、閲覧ビューが「空行を飛ばした次の行」で食い違っていた)。
 * frontmatter の中は見ない。 */
function speakerValidityIn(lines, idx) {
	var from = bodyStartOf(lines);
	var fence = fenceMapOf(lines, from);
	return speakerValidity(lines, idx, cutLineOf(lines, fence.inside, from));
}

/* **閲覧ビュー用**: ÷÷÷÷ の行 (0 始まり)。無ければ -1。**フェンスの中の ÷÷÷÷ は数えない**
 * (name-spec 3078bd5: フェンスを ÷÷÷÷ より先に見る)。以前は CUT_RE を全行に当てていたので、
 * フェンスの中の見本の ÷÷÷÷ でも打ち切って、**編集ビュー・発話者の登録と答えが違った**。
 * 閉じていないフェンスは最後まで原稿ではないので、その後ろの ÷÷÷÷ も数えない。
 * frontmatter の中は見ない。 */
function readingCutLineOf(lines) {
	var from = bodyStartOf(lines);
	var fence = fenceMapOf(lines, from);
	var stop = cutLineOf(lines, fence.inside, from);
	return stop < lines.length ? stop : -1;
}

/* 本文の始まりの行 (0 始まり)。frontmatter (--- で始まるブロック) があればその次の行、無ければ 0。 */
function bodyStartOf(lines) {
	if (lines.length > 0 && markOf(lines[0]) === "---") {
		for (var j = 1; j < lines.length; j++) {
			if (markOf(lines[j]) === "---") {
				return j + 1;
			}
		}
	}
	return 0;
}

/* 台詞のブロックの終わり: start (`>` で始まる行) から、**連続する `>` の行**の次の行番号を返す。
 * 台詞の範囲の規則はここ 1 か所 (collectItems と、空のふきだしの位置を数える側が同じ答えを使う。
 * 別々に書くと、空のふきだしの位置が行 ID の台詞の範囲とずれる)。
 * フェンスの中の行は読まない (inside が渡されたとき)。 */
function dialogueRunEnd(lines, start, inside) {
	var i = start;
	while (i < lines.length && markOf(lines[i]).indexOf(">") === 0
			&& !(inside && inside[i])) {
		i++;
	}
	return i;
}

/* 台詞のブロック (line..line_end) が**空のふきだし**か: 全行が `>` と空白だけ。
 * 仕様は「空のふきだしは台詞にせず、作者に知らせる」(2026-10-01・ユーザー判断)。
 * **要素にしない** (collectItems が返さず、直後の行 ID は捨てる。name-spec 3078bd5・
 * 作者判断。Godot 側と同じ答え)。**波線で知らせる**のは段階 ② (これから)。 */
function isEmptyBalloon(lines, item) {
	for (var i = item.line; i <= item.line_end; i++) {
		if (!/^[ \t]*>[ \t]*$/.test(lines[i])) {
			return false;
		}
	}
	return true;
}

/* **書いている最中に知らせる、本文の 2 種** (name-spec MDNAME.md §4.1・§4.2)。
 * 無効な発話者の行 (次に来る行が台詞でない) と、空のふきだし (全行が `>` と空白だけの台詞)。
 * **着色・波線 (buildDecorations) と、台本が見る欄 (bodySummaryOf) が同じ答えを使う**。
 * 戻り値: {
 *   orphanSpeakers: [{ line, decidedAt }]   line = 発話者の行 / decidedAt = 判定を決めた行 (無ければ -1)
 *   emptyDialogues: [{ line, lineEnd }]     line = 最初の `>` の行 / lineEnd = ブロックの最後の行
 * }  どれも 0 始まり。範囲は start (含む) から stop (含まない)。フェンスの中は見ない。
 * **崩れた発話者の行 (`**名前` のように閉じていない行) は対象外** —— 仕様が「知らせる仕組みは
 * 今回入れない」と決めている (引き継ぎで黙って前の発話者の台詞になる。記録だけ)。 */
function manuscriptNoticesOf(lines, inside, start, stop) {
	var orphans = [];
	var empties = [];
	var i = start;
	while (i < stop) {
		if (inside[i]) {
			i++;
			continue;
		}
		var t = markOf(lines[i]);
		if (t.indexOf(">") === 0) {
			var end = dialogueRunEnd(lines, i, inside);
			if (isEmptyBalloon(lines, { line: i, line_end: end - 1 })) {
				empties.push({ line: i, lineEnd: end - 1 });
			}
			i = end;
			continue;
		}
		// 発話者の行。*** で始まるテロップは違う (SPEAKER_RE は ** の中に * を許さないので除かれる)
		if (SPEAKER_RE.test(t)) {
			var v = speakerValidity(lines, i, stop);
			if (!v.valid) {
				orphans.push({ line: i, decidedAt: v.decidedAt });
			}
		}
		i++;
	}
	return { orphanSpeakers: orphans, emptyDialogues: empties };
}

/* 原稿の本文の要約 (**台本が見る欄**)。ページごとの { id, dialogues, directions } の順の配列と、
 * 原稿の外側の誤り (重複・閉じないフェンス)。**台詞の本文や発話者は持たない** ——
 * この実装が見るのはページの境目と台詞のブロックの数、ト書きの数まで (コーパスの `_doc`
 * 「実装ごとに見る欄が違ってよい」)。collectItems (行 ID) と同じ走査を使うので、ずれない。
 * 戻り値: { pages: [{ id, dialogues: 数, directions: 数 }], errors: [{ kind, line }],
 *           orphanSpeakers: [行], emptyDialogues: [行] }
 *   errors・orphanSpeakers・emptyDialogues の行は 0 始まり (コーパスと同じ)。
 *   orphanSpeakers = 無効な発話者の行 (次に来る行が台詞でない) / emptyDialogues = 空のふきだしの
 *   最初の `>` の行。**波線の知らせ (buildDecorations) と同じ答えを使う**。 */
function bodySummaryOf(text) {
	var lines = splitLinesOf(text);
	var start = bodyStartOf(lines);
	var fence = fenceMapOf(lines, start);
	var items = collectItems(text);
	var pages = [];
	var cursor = 0;   // items の読み進め位置
	// ページの境目はページ見出しの行。÷÷÷÷ 以降はメモなのでそこで止める
	var stop = cutLineOf(lines, fence.inside, start);
	var heads = [];
	for (var h = start; h < stop; h++) {
		if (!fence.inside[h]) {
			var id = pageHeadingId(lines[h]);
			if (id !== null) {
				heads.push({ line: h, id: id });
			}
		}
	}
	for (var k = 0; k < heads.length; k++) {
		var from = heads[k].line;
		var to = k + 1 < heads.length ? heads[k + 1].line : stop;
		var page = { id: heads[k].id, dialogues: 0, directions: 0 };
		while (cursor < items.length && items[cursor].line < to) {
			if (items[cursor].line > from) {
				if (items[cursor].kind === "dialogue") {
					page.dialogues++;   // 空のふきだしは collectItems が返さない (台詞に数えない)
				} else if (items[cursor].kind === "direction") {
					page.directions++;
				}
			}
			cursor++;
		}
		pages.push(page);
	}
	var errors = [];
	var dup = duplicatePageLines(lines, fence.inside);
	for (var d in dup) {
		if (Object.prototype.hasOwnProperty.call(dup, d)) {
			errors.push({ kind: "duplicate_page", line: parseInt(d, 10) });
		}
	}
	if (fence.unclosedAt >= 0) {
		errors.push({ kind: "unclosed_fence", line: fence.unclosedAt });
	}
	var notices = manuscriptNoticesOf(lines, fence.inside, start, stop);
	return {
		pages: pages, errors: errors,
		orphanSpeakers: notices.orphanSpeakers.map(function (o) { return o.line; }),
		emptyDialogues: notices.emptyDialogues.map(function (e) { return e.line; })
	};
}

/* 1 行の色 (行クラス) を決める。**編集ビューの判定をそのまま関数にしたもの**で、
 * ドキュメントに触らないので単体で試せる (test/run_highlight.js)。
 *   raw           … 行の生テキスト
 *   validSpeaker … **この行が有効な発話者か** (次に来る行が台詞のとき。空行・行 ID・cmd・コメントは
 *                   飛ばして見る。speakerValidity)。発話者でない行では使われない
 *   cut           … ここまでに ÷÷÷÷ が出たか
 *   prevDirection … 直前の行がト書き扱いだったか (折り返し継続行のため)
 * 戻り値: { cls, ruby, cut, prevDirection } ―― cut と prevDirection は次の行へ持ち越す */
function lineClassOf(raw, validSpeaker, cut, prevDirection) {
	const t = markOf(raw);
	let cls = null;
	let ruby = false;
	if (cut) {
		cls = "mdname-cut";
	} else if (t.indexOf("÷÷÷÷") === 0) {   // 打ち切りマーカー (以降はメモ)。前の空白は半角空白とタブだけ削る (markOf)
		cut = true;
		cls = "mdname-cut";
	} else if (ID_LINE_RE.test(t)) {
		// 行 ID は**書式ではなく付帯情報**なので薄く出す (原稿が読みやすくなる)。
		// 自動付与を使うほど行数が増えるので、ここを地の文の色で出すと邪魔になる
		cls = "mdname-lineid";
	} else if (CMD_LINE_RE.test(t)) {
		// 画面への指示 `<!--cmd:clear-->` は**作者が書く演出指示**なので、
		// 行 ID とは**別の色ではっきり出す** (あちらは機械が付ける印なので薄い)。
		// 目で探せることが要る ―― どこで画面を区切ったかは原稿を読んで追うため
		cls = "mdname-cmd";
	} else if (SCENE_RE.test(raw)) {
		cls = "mdname-scene";
	} else if (HEADING_RE.test(raw)) {
		cls = "mdname-heading";
	} else if (t.startsWith(">")) {
		cls = "mdname-dialogue";
		ruby = true;
	} else if (SPEAKER_RE.test(t) && validSpeaker) {
		cls = "mdname-speaker";
	} else if (TELOP_RE.test(t)) {
		cls = "mdname-telop";
		ruby = true;
	} else if (ANNOT_RE.test(t)) {
		cls = "mdname-annotation";
	} else if (BRANCH_PROMPT_RE.test(t)) {
		cls = "mdname-branch-prompt";
	} else if (BRANCH_CHOICE_RE.test(t)) {
		cls = "mdname-branch-choice";
	} else if (DIRECTION_RE.test(t)) {
		cls = "mdname-direction";
	} else if (t !== "") {
		// ト書き直後の折り返し行は Markdown の継続行としてト書き色を引き継ぐ。
		// それ以外の地の文はグレー (txtName Highlight と同じ方針)
		cls = prevDirection ? "mdname-direction" : "mdname-plain";
	}
	return {
		cls: cls,
		ruby: ruby,
		cut: cut,
		// **行 ID と指示の行はト書きの継続の鎖を切らない**。どちらも要素ではなく
		// 行のあいだに入るので、切ると「ト書き → ID 行 → 折り返しの続き」で
		// 続きの色が変わってしまう
		prevDirection: (cls === "mdname-lineid" || cls === "mdname-cmd")
			? prevDirection : cls === "mdname-direction",
	};
}

/* ドキュメント全体を行走査して行デコレーションを組み立てる。
 * 原稿サイズは高々数千行なので全体走査で十分速い。 */
function buildDecorations(view) {
	const info = view.state.field(editorInfoField, false);
	const file = info ? info.file : null;
	if (!file || file.extension !== "md") {
		return Decoration.none;
	}
	const doc = view.state.doc;
	// mdName 判定: ページ見出しが無い .md (通常ノート) には何もしない
	const head = doc.sliceString(0, Math.min(doc.length, DETECT_SLICE)).replace(/^\uFEFF/, "");
	if (!MDNAME_DETECT_RE.test(head)) {
		return Decoration.none;
	}
	const builder = new RangeSetBuilder();
	const cursorLine = cursorLineOf(view.state);
	const fmEnd = frontmatterEnd(doc);
	// **原稿の外側** (name-spec MDNAME.md §1・§3): コードフェンスの中と、ページ id の重複。
	// 行ごとの判定では決まらない (前の行の状態で変わる) ので、全体を 1 回走査しておく
	const allLines = [];
	for (let k = 1; k <= doc.lines; k++) {
		// 1 行目の先頭の BOM は原稿に含めない (Obsidian が外して渡すか確かめていないので、ここでも落とす)
		allLines.push(k === 1 ? doc.line(k).text.replace(/^\uFEFF/, "") : doc.line(k).text);
	}
	const fence = fenceMapOf(allLines, fmEnd);   // fmEnd = frontmatter の最終行 (1 始まり) = 次の行 (0 始まり)
	const dupPages = duplicatePageLines(allLines, fence.inside);
	const unclosedWarnAt = unclosedFenceWarnLine(allLines, fence.unclosedAt);
	// **本文の知らせ** (name-spec MDNAME.md §4.1・§4.2): 無効な発話者 (次に来る行が台詞でない) と空のふきだし。
	// 発話者の有効性は着色にも使う (空行・行 ID・cmd・コメントを飛ばして次が台詞なら有効)
	const stopAt = cutLineOf(allLines, fence.inside, fmEnd);
	const notices = manuscriptNoticesOf(allLines, fence.inside, fmEnd, stopAt);
	const orphanAt = {};      // 発話者の行 (0 始まり) → 判定を決めた行
	for (const o of notices.orphanSpeakers) {
		orphanAt[o.line] = o.decidedAt;
	}
	const emptyAt = {};       // 空のふきだしの最初の行 (0 始まり) → ブロックの最後の行
	for (const e of notices.emptyDialogues) {
		emptyAt[e.line] = e.lineEnd;
	}
	let cut = false; // ÷÷÷÷ 以降
	let prevDirection = false; // 直前の行がト書き (折り返し継続行の判定用)
	for (let i = 1; i <= doc.lines; i++) {
		const line = doc.line(i);
		// **フェンスの中は原稿ではない**: 着色も波線もしない (見本の ## p.002 や > 台詞が
		// 本物に見えないように)。÷÷÷÷ の判定も飛ばす (見本の中の ÷÷÷÷ で打ち切らない)
		if (fence.inside[i - 1] && i > fmEnd) {
			// 閉じていないフェンスを波線で知らせる (最後まで原稿ではなくなる)。
			// **打っている最中は出さない**: ``` を打った直後は、まだ閉じていなくて当然。
			// カーソルが開いた行か、波線を付ける行にあるあいだは出さない
			if (i - 1 === unclosedWarnAt && i !== cursorLine && cursorLine - 1 !== fence.unclosedAt) {
				const onOpenLine = (unclosedWarnAt === fence.unclosedAt);
				builder.add(line.from, line.from, Decoration.line({
					class: "mdname-heading-warn",
					attributes: { title: onOpenLine
						? "コードフェンスが閉じていません (この行から最後まで原稿として読まれません)"
						: "上のコードフェンス (" + (fence.unclosedAt + 1) + " 行目) が閉じていません。そこから最後まで原稿として読まれません" }
				}));
			}
			continue;
		}
		// 発話者の行は、次に来る行が台詞のときだけ有効 (**無効なら着色しない**。orphanAt に無ければ有効)
		let r = lineClassOf(allLines[i - 1], !Object.prototype.hasOwnProperty.call(orphanAt, i - 1), cut, prevDirection);
		// **frontmatter の中の ÷÷÷÷ は打ち切りの印ではない**。frontmatter は原稿の外 (閲覧ビュー・
		// 発話者の登録・行 ID・本文のコーパスは、frontmatter の後ろから数える) ので、ここだけ数えると
		// 編集ビューだけ本文が全部メモの色になる (2026-10-02 作者判断で揃えた)
		if (i <= fmEnd && r.cut) {
			r = { cls: "mdname-plain", ruby: false, cut: false, prevDirection: false };
		}
		cut = r.cut;
		prevDirection = r.prevDirection;
		// 崩れた見出しの波線 (決定②)。**打っている行には出さない** —— `## p.002-00` や
		// `## p.` は打ち途中に一瞬そう見えるので、出すと打つたびにちらつく。
		// frontmatter と ÷÷÷÷ 以降は「行の外」なので出さない (コーパスの _doc)
		let notice = null;
		if (i !== cursorLine && i > fmEnd && r.cls !== "mdname-cut") {
			notice = pageHeadingNotice(allLines[i - 1]);
			// ページ id の重複は**2 つ目以降**に知らせる (崩れた見出しではないので別の文言)
			if (notice === null && dupPages[i - 1]) {
				notice = "同じ id のページが前にもあります (id は重複できません)";
			}
		}
		// 無効な発話者・空のふきだし。**打っている最中は出さない**: 発話者を打って Enter を押した
		// 直後は、まだ > を打つ前で、毎回出てしまう。カーソルが「発話者の行から、判定を決めた行まで」
		// (空のふきだしならブロックの中) にあるあいだは出さない
		if (notice === null && i > fmEnd && r.cls !== "mdname-cut") {
			if (Object.prototype.hasOwnProperty.call(orphanAt, i - 1)) {
				const decided = orphanAt[i - 1] >= 0 ? orphanAt[i - 1] : allLines.length - 1;
				if (!(cursorLine - 1 >= i - 1 && cursorLine - 1 <= decided)) {
					notice = "発話者の次が台詞ではありません (空行・行 ID・コメントは飛ばして見ます)。この行は本文になりません";
				}
			} else if (Object.prototype.hasOwnProperty.call(emptyAt, i - 1)) {
				if (!(cursorLine - 1 >= i - 1 && cursorLine - 1 <= emptyAt[i - 1])) {
					notice = "台詞が空です (> だけの行)。ふきだしは作られません";
				}
			}
		}
		// **ページ見出しの行は、話の題 (`#`) と見た目を分ける** (2026-10-04 作者判断。罫線と帯 + 見開きの印)。
		// 事故の元は、エディタで `#` と `##` の行が同じ見た目だったこと (E4P_2-17 の `# p.014-015` が題として
		// 読まれ、見開きの中身が黙って前のページに入った)。ページ見出し = 「ページになる行」(pageHeadingOf)。
		// 色は変えない (色は「何の記法か」の体系で、ト書き・柱書き・台詞などと紛れるため。罫線と帯は色に頼らない)
		let pageClass = "";
		if (i > fmEnd && r.cls !== "mdname-cut") {
			const pk = pageHeadingOf(allLines[i - 1]).kind;
			if (Object.prototype.hasOwnProperty.call(PAGE_KINDS, pk)) {
				pageClass = "mdname-pagehead"
					+ ((pk === "spread" || pk === "bad_spread") ? " mdname-pagehead-spread" : "");
			}
		}
		if (r.cls || notice || pageClass) {
			// 波線を付ける行の**直後がコードフェンス**なら、位置を上げる印を足す。Live Preview は
			// フェンスを図として描き、その上端が直前の行の波線の下半分に重なって隠す (実機で確認)。
			// この行は原稿の側 (フェンスの中の行は上で continue 済み) なので、次の行がフェンスの中なら開く行
			const aboveFence = notice && i < doc.lines && fence.inside[i];
			const warn = "mdname-heading-warn" + (aboveFence ? " mdname-warn-above-fence" : "");
			const classes = [r.cls, pageClass, notice ? warn : ""].filter(function (c) { return c; }).join(" ");
			const spec = { class: classes };
			if (notice) {
				spec.attributes = { title: notice };   // ホバーで理由
			}
			builder.add(line.from, line.from, Decoration.line(spec));
			if (r.ruby) {
				addRubyMarks(builder, line);
			}
		}
	}
	return builder.finish();
}

/* カーソル (主選択の先端) がある行の番号 (1 始まり) */
function cursorLineOf(state) {
	return state.doc.lineAt(state.selection.main.head).number;
}

/* frontmatter (--- で始まるブロック) の終わりの行番号 (1 始まり)。無ければ 0 */
function frontmatterEnd(doc) {
	// 1 行目の先頭の BOM は原稿に含めない (Obsidian が外して渡すか確かめていないので、ここでも落とす)
	if (doc.lines < 1 || markOf(doc.line(1).text.replace(/^\uFEFF/, "")) !== "---") {
		return 0;
	}
	for (let i = 2; i <= doc.lines; i++) {
		if (markOf(doc.line(i).text) === "---") {
			return i;
		}
	}
	return 0;
}

const mdnameViewPlugin = ViewPlugin.fromClass(
	class {
		constructor(view) {
			this.cursorLine = cursorLineOf(view.state);
			this.decorations = buildDecorations(view);
		}
		update(update) {
			// カーソルが**別の行へ移ったとき**も組み直す —— 打ち終えて行を離れた瞬間に
			// 崩れた見出しの波線を出すため (同じ行の中の移動では組み直さない)
			const cl = cursorLineOf(update.state);
			if (update.docChanged || update.viewportChanged || cl !== this.cursorLine) {
				this.cursorLine = cl;
				this.decorations = buildDecorations(update.view);
			}
		}
	},
	{ decorations: (v) => v.decorations }
);

/* ---- 閲覧 (リーディング) モード ----
 * 編集モードは CodeMirror の行デコレーションだが、閲覧モードは Markdown→HTML 変換を
 * 経るので別処理が要る。registerMarkdownPostProcessor で描画後の各ブロック要素に、
 * 元テキストの該当行から判定した行クラス (mdname-*) を付ける。CSS 側は編集/閲覧の
 * 両方に効くセレクタを用意している。 */

/* ブロックの先頭ソース行から行クラスを決める (編集モードの分類規則と対応)。
 * cutLine = ÷÷÷÷ の行番号 (0-based, 無ければ -1)。 */
function classifyBlock(lines, lineStart, cutLine) {
	const rawLine = lines[lineStart] || "";
	const t = markOf(rawLine);
	if (cutLine >= 0 && lineStart >= cutLine) {
		return "mdname-cut";
	}
	if (SCENE_RE.test(rawLine)) {
		return "mdname-scene";
	}
	if (HEADING_RE.test(rawLine)) {
		return "mdname-heading";
	}
	if (t.startsWith(">")) {
		return "mdname-dialogue";
	}
	if (SPEAKER_RE.test(t) && speakerValidityIn(lines, lineStart).valid) {
		return "mdname-speaker";
	}
	if (TELOP_RE.test(t)) {
		return "mdname-telop";
	}
	if (ANNOT_RE.test(t)) {
		return "mdname-annotation";
	}
	if (BRANCH_PROMPT_RE.test(t)) {
		return "mdname-branch-prompt";
	}
	if (BRANCH_CHOICE_RE.test(t)) {
		return "mdname-branch-choice";
	}
	if (DIRECTION_RE.test(t)) {
		return "mdname-direction";
	}
	if (t !== "") {
		return "mdname-plain";
	}
	return null;
}

/* 閲覧モードで、要素内のテキストノードに含まれるルビ (<...> と 厳密指定 |...| ) を
 * span.mdname-ruby で包む (編集モードの addRubyMarks と同じ collectRubyRanges を使用)。
 * 台詞は <blockquote> の中の <p>、テロップは <code> のテキストノードが対象。
 * <かんじ> は非 ASCII なので HTML タグにならず、リテラル文字列として現れる。 */
function wrapRubyInReading(root) {
	// 要素の文書で作る (`document` を直接使うと、別ウィンドウ (ポップアウト) に開いたノートで食い違う)
	var doc = root.ownerDocument;
	var walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
	var targets = [];
	var n;
	while ((n = walker.nextNode())) {
		if (/<[^<>]+>/.test(n.nodeValue)) {
			targets.push(n);
		}
	}
	for (var i = 0; i < targets.length; i++) {
		var node = targets[i];
		var text = node.nodeValue;
		var ranges = collectRubyRanges(text);
		if (ranges.length === 0) {
			continue;
		}
		var frag = doc.createDocumentFragment();
		var last = 0;
		for (var j = 0; j < ranges.length; j++) {
			var r = ranges[j];
			if (r.start > last) {
				frag.appendChild(doc.createTextNode(text.slice(last, r.start)));
			}
			var span = doc.createElement("span");
			span.className = "mdname-ruby";
			span.textContent = text.slice(r.start, r.end);
			frag.appendChild(span);
			last = r.end;
		}
		if (last < text.length) {
			frag.appendChild(doc.createTextNode(text.slice(last)));
		}
		node.parentNode.replaceChild(frag, node);
	}
}

/* 閲覧モードで発話者の所属 @所属 を ＜所属＞ 表示にする。
 * 例: 警察犬＠石神井警察署 → 警察犬＜石神井警察署＞
 * 半角 @ / 全角 ＠ の両方を対象にし、acting (:/；等以降) はそのまま残す。
 * el (<strong> を含むブロック) 内の @ を含むテキストノードを書き換える。 */
function transformAffiliationInReading(el) {
	var walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
	var targets = [];
	var n;
	while ((n = walker.nextNode())) {
		if (/[@＠]/.test(n.nodeValue)) {
			targets.push(n);
		}
	}
	for (var i = 0; i < targets.length; i++) {
		var node = targets[i];
		var text = node.nodeValue;
		var at = text.search(/[@＠]/);
		if (at < 0) {
			continue;
		}
		var name = text.slice(0, at);
		var rest = text.slice(at + 1); // 所属[:acting]
		var sep = rest.search(/[:：;；]/); // acting 区切りより前を所属とする
		var aff = sep >= 0 ? rest.slice(0, sep) : rest;
		var tail = sep >= 0 ? rest.slice(sep) : "";
		node.nodeValue = name + "＜" + aff + "＞" + tail;
	}
}

/* 閲覧モードの分岐ブロックの表示調整。<li> ごとに対応するソース行を見て:
 * - 選択肢のリンク前に " : " を挿入
 *   例: 1. 逃げる[[neco#p.002-003]] → 1. 逃げる : neco > p.002-003
 * - 導入文 0. は番号を隠す (mdname-branch-intro。選択肢の 1. 2. はそのまま)
 * - 0. がリンクのみ (無条件遷移) は番号を隠し「→」を付ける (mdname-branch-jump)
 *   例: 0. [[GAMEOVER]] → 「→ GAMEOVER」
 * lines/lineStart はソース行との対応付け用 (1行 = 1 <li> 前提)。 */
function decorateBranchInReading(el, lines, lineStart) {
	var lis = el.querySelectorAll("li");
	for (var i = 0; i < lis.length; i++) {
		var srcLine = markOf(lines[lineStart + i] || "");
		var isPrompt = BRANCH_PROMPT_RE.test(srcLine);
		var a = lis[i].querySelector("a");
		var hasLabel = false;
		if (a) {
			for (var p = a.previousSibling; p; p = p.previousSibling) {
				// ゲーム用コード `...` は選択肢ラベルではないので数えない
			// (コードだけの 0. 行はリンク単独扱い = 無条件遷移の矢印表示を保つ)
				if (p.nodeType === 1 && p.tagName === "CODE") {
					continue;
				}
				if (p.textContent && p.textContent.trim() !== "") {
					hasLabel = true;
					break;
				}
			}
		}
		if (isPrompt) {
			if (a && !hasLabel) {
				lis[i].classList.add("mdname-branch-jump"); // 無条件遷移: 番号→矢印
				a.parentNode.insertBefore(a.ownerDocument.createTextNode("→ "), a);
				continue;
			}
			lis[i].classList.add("mdname-branch-intro"); // 導入文: 番号を隠す
		}
		if (a && hasLabel) {
			a.parentNode.insertBefore(a.ownerDocument.createTextNode(" : "), a);
		}
	}
}

function readingPostProcess(el, ctx) {
	var info = ctx.getSectionInfo(el);
	if (!info) {
		return; // ソース位置が取れないネスト要素等はスキップ
	}
	// 先頭の BOM は原稿に含めない。**行の数え方は変えない** (ソース位置 sectionInfo は Obsidian の数え方なので、
	// 単独の CR を改行にする splitLinesOf は使わない)
	var text = info.text.replace(/^\uFEFF/, "");
	if (!MDNAME_DETECT_RE.test(text)) {
		return; // ページ見出しの無い通常ノートには何もしない
	}
	var lines = text.split("\n");
	var cutLine = readingCutLineOf(lines);
	var cls = classifyBlock(lines, info.lineStart, cutLine);
	if (cls) {
		el.classList.add(cls);
		if (cls === "mdname-dialogue" || cls === "mdname-telop") {
			wrapRubyInReading(el); // 台詞・テロップ内のルビ <...> を淡色化
		}
		if (cls === "mdname-speaker") {
			transformAffiliationInReading(el); // @所属 → ＜所属＞ (閲覧モードのみ)
		}
		if (cls === "mdname-branch-prompt" || cls === "mdname-branch-choice") {
			decorateBranchInReading(el, lines, info.lineStart); // " : " 挿入・0. の表示調整
		}
	}
}

/* ---- 行 ID を配る対象の抽出 ----
 *
 * **着色の判定 (classifyBlock) を流用しない。** あちらは色を塗るための行ベース近似で、
 * 少しずれても見た目の話で済む。ID の位置がずれると**間違った対応を ID で固定して
 * しまう**ので、Godot 側の mdname_parser.gd と**同じ厳しさ**の判定を別に持つ。
 * 実際に食い違う例: 着色の判定は**ページ見出しの全角 (`## ｐ．００１`) を通し、
 * `##` の直後の空白も要求しない**が、本家は半角で `## p.001` の形しか
 * ページとみなさない。**その原稿では本家が丸ごと 1 ページも認識しない**ので、
 * ゆるい判定で ID を配ると本家と対応が取れない (コーパスで固定してある)。
 *
 * **両実装のずれはコーパスで縛る**: 正は name-spec の corpus/lineid_corpus.json
 * (このリポジトリからは vendor/name-spec で引く)。
 *   JS   : node test/run_corpus.js          / sh test/run_corpus.jsc.sh (mac)
 *   Godot: --headless --path <name-balloons> --script res://test/test_lineid_corpus.gd
 * 仕様を変えるときはコーパスを先に直し、両方で通すこと。 */

/* ページ見出しの判定 (**全実装で同じ答えを出す**)。正は name-spec の MDNAME.md §3
 * (ページ見出し)、答えは corpus/page_heading_corpus.json (2026-09-29)。
 *   JS   : node test/run_page_heading_corpus.js / sh test/run_page_heading_corpus.jsc.sh
 *
 * **空白類は ECMAScript の `\s` と同じ 25 字** (U+0009〜000D・U+0020・U+00A0・U+1680・
 * U+2000〜200A・U+2028・U+2029・U+202F・U+205F・U+3000・U+FEFF。U+0085 は含めない)。
 * **JS は `\s` / `\S` をそのまま使ってよい** (Lua と Godot は文字で列挙する)。
 * ただし**行の前後から削るのも、`##` と `p.` の間に置けるのも半角空白とタブだけ**。
 * **見出しの中に、半角空白とタブ以外の空白類があれば broken** (全角空白・NBSP・U+2009 …)。
 * 以前は `line.trim()` と `/^##\s+…\s*$/` を素直に当てていたので、**`\s` が空白類すべてに
 * 当たる**せいで「削る」と「見出しの中にある」を区別できず、全角空白の 3 行が
 * ページになっていた (Godot は id に全角空白を含めて割れていた)。
 * **`trim()` は使わない** (全角空白も NBSP も削る)。**ほかの要素の判定の `trim()` は
 * 変えない** (ここだけの話)。
 *
 * NBSP は **Mac の英字入力で Option を押したまま空白を打つと入る** (作者は Mac で書く)。
 * 見えない文字なので、JS は id に含めず broken、Godot と Lua は id に含めて割れていた。
 *
 * pageHeadingOf の戻り値: { kind, id, first, last }
 *   kind  single / spread / bad_spread / typo / other … ページ
 *         broken … ページ見出しに見えるが、ページ見出しではない (崩れた見出し)
 *         none   … ページ見出しに見えない
 *   id    ページなら `p.` の後ろの 1 語 (原文どおり)、そうでなければ null
 *   first / last  spread / bad_spread のときの 2 つの数字 (原文どおり)
 * **kind の決め方はコーパスの _doc が正。** ここはそれを写しただけ。 */
const ID_PAGE_RE = /^##[ \t]+[pP]\.(\S+)$/;
const PAGE_KINDS = { single: 1, spread: 1, bad_spread: 1, typo: 1, other: 1 };
const NOTIFY_KINDS = { broken: 1, bad_spread: 1, typo: 1 };
// typo の判定で半角ハイフンに寄せる文字 (横線・波線・下線)
const TYPO_DASH_RE = /[‐‑‒–—―−－ー〜～~_]/g;

function stripHalfSpace(s) {
	return String(s).replace(/^[ \t]+|[ \t]+$/g, "");
}
// 全角の英数字・記号を半角に、空白類を半角空白に (「見出しに見えるか」を決めるためだけ)
function toHalfWidth(s) {
	return String(s).replace(/[\uFF01-\uFF5E]/g, function (c) {
		return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
	}).replace(/\s/g, " ");
}
/* 半角空白とタブ以外の空白類が 1 つでもあるか。**理由の文を選ぶためだけ**に使う
 * (判定そのものは ID_PAGE_RE が決める。pageHeadingOf を見よ) */
const NON_HALF_SPACE_RE = /[^\S \t]/;
function typoNormalize(id) {
	return String(id).replace(/[０-９]/g, function (c) {
		return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
	}).replace(TYPO_DASH_RE, "-");
}

function pageHeadingOf(rawLine) {
	var none = { kind: "none", id: null, first: null, last: null };
	// **`##` で始まる `p.` 行だけが、ページ見出しに見える行** (MDNAME.md §3)。**`#` が 1 つの行は話の題の印**で、
	// `p.` で始まっても none (`# P.S. 追記` のような題を崩れた見出しにすると、txt2mdp が止まる)。`###` 以上も none。
	// 2026-10-03 に `#` の行も崩れた見出しにしたが (f893ddc)、副作用が大きいので 2026-10-04 に戻した (name-spec 56674c7)。
	// 事故 (E4P_2-17 の `# p.014-015` が none で、見開きの中身が前のページに入った) の手当ては、
	// 編集ビューでページ見出しと題の見た目を分けること (buildDecorations)
	if (!/^##[ \t]*[pP]\./.test(stripHalfSpace(toHalfWidth(rawLine)))) {
		return none;
	}
	var s = stripHalfSpace(rawLine);
	// **空白類の列挙はここに書かない。** ID_PAGE_RE の `[ \t]+` (## と p. の間) と
	// `\S+$` (id に空白類を含めない) が、JS では `\s` の 25 字がそのまま定義なので
	// 行頭・行末・間・id の中のどこにあっても弾く。全角空白や NBSP を別に判定していた
	// 版は、外しても 52 件・25 字 × 4 位置で kind が 1 つも変わらなかった (冗長だった)
	var m = s.match(ID_PAGE_RE);
	if (!m) {
		return { kind: "broken", id: null, first: null, last: null };
	}
	var id = m[1];
	if (/^[0-9]+$/.test(id)) {
		return { kind: "single", id: id, first: null, last: null };
	}
	var sp = id.match(/^([0-9]+)-([0-9]+)$/);
	if (sp) {
		var ok = parseInt(sp[2], 10) === parseInt(sp[1], 10) + 1;
		return { kind: ok ? "spread" : "bad_spread", id: id, first: sp[1], last: sp[2] };
	}
	if (/^[0-9]+(-[0-9]+)?$/.test(typoNormalize(id))) {
		return { kind: "typo", id: id, first: null, last: null };
	}
	return { kind: "other", id: id, first: null, last: null };
}

/* ページ見出しなら id (原文どおり)、そうでなければ null。行 ID と「次のページ」が使う */
function pageHeadingId(rawLine) {
	var h = pageHeadingOf(rawLine);
	return Object.prototype.hasOwnProperty.call(PAGE_KINDS, h.kind) ? h.id : null;
}

/* **書いている最中に知らせる** (name-spec の決定②)。知らせる行なら理由の文を、
 * そうでなければ null を返す。**対象は kind が broken / bad_spread / typo の行**。
 * 着色は `#` `##` の行をすべて見出しの色にするので、崩れた見出しもページに見える ——
 * **txt2mdp を通すまで気づけなかった穴**を塞ぐためのもの。
 * 文言は案内で、答えではない (答えは kind)。 */
/* 見出しの中に半角空白とタブ以外の空白類があるときの理由。**入っている文字ごとに言い分ける**。
 * 全角空白は目で見て分かるが、**NBSP や U+2009 は見えない**ので、「全角の空白」と
 * 言うと原因に辿り着けない (実機で指摘された。NBSP なのに全角空白の説明が出た)。
 * 優先順は、見えないもの (NBSP → そのほか) を先にし、全角空白は最後。 */
function invisibleSpaceNotice(s) {
	if (s.indexOf("\u00A0") >= 0) {
		return "改行しない空白 (NBSP) が入っています。Mac で Option を押したまま空白を打つと入ります (見出しの空白は半角だけ)"
			+ showNonHalfSpaces(s);
	}
	var other = s.match(/[^\S \t\u3000]/);
	if (other) {
		return "見えない空白 (" + spaceCode(other[0].charCodeAt(0)) + ") が入っています (見出しの空白は半角だけ)"
			+ showNonHalfSpaces(s);
	}
	return "全角の空白が入っています (見出しの空白は半角だけ)";
}
/* 見えない空白の**位置**を、行の中に `[U+00A0]` の形で出す (理由文の末尾に足す)。
 * 理由は 1 つだけ言うが、**この行は全部の位置を出す** —— NBSP は目に見えないので、
 * 「入っています」と言われても**どこを直すのか**が分からない (name-tools の txt2mdp T028 と同じ形)。
 * 探す字は NON_HALF_SPACE_RE と同じ 23 字 (**判定と表示は同じ集合**)。半角空白とタブは
 * 置き換えない (見出しの中で許される字で、並べると原因が埋もれる)。 */
function showNonHalfSpaces(s) {
	return "  →  " + String(s).replace(/[^\S \t]/g, function (ch) {
		return "[" + spaceCode(ch.charCodeAt(0)) + "]";
	});
}
function spaceCode(cp) {
	return "U+" + ("0000" + cp.toString(16).toUpperCase()).slice(-4);
}

function pageHeadingNotice(rawLine) {
	var h = pageHeadingOf(rawLine);
	if (!Object.prototype.hasOwnProperty.call(NOTIFY_KINDS, h.kind)) {
		return null;
	}
	if (h.kind === "bad_spread") {
		if (parseInt(h.first, 10) === parseInt(h.last, 10)) {
			return "同じ番号の見開きです。1 ページなら ## p." + h.first;
		}
		return "見開きは「後ろ = 前 + 1」です (例: ## p.002-003)";
	}
	if (h.kind === "typo") {
		return "打ち間違いかもしれません。## p." + typoNormalize(h.id) + " のつもりですか";
	}
	// broken: いちばん当たりそうな理由を 1 つだけ出す
	var s = stripHalfSpace(rawLine);
	var ws = s.match(NON_HALF_SPACE_RE);
	if (ws) {
		return invisibleSpaceNotice(s);
	}
	// `## p.` の部分 (最初の半角の `.` まで。無ければ行全体) に全角文字があるか
	var dot = s.indexOf(".");
	if (/[！-～]/.test(dot >= 0 ? s.slice(0, dot + 1) : s)) {
		return "全角の文字が入っています (## p. は半角で)";
	}
	if (/^##[pP]/.test(s)) {
		return "## の後ろに半角の空白が要ります";
	}
	if (/^##[ \t]+[pP]\.$/.test(s)) {
		return "p. の後ろにページ番号がありません";
	}
	if (/^##[ \t]+[pP]\.[ \t]/.test(s)) {
		return "p. の後ろに空白があります (詰めて書く)";
	}
	return "p. の後ろが 1 語になっていません (後ろに語・飾り・空白がある)";
}
const ID_TELOP_RE = /^\*\*\*(.+?)\*\*\*[ \t]*$/;    // ***テロップ***
const ID_SPEAKER_RE = /^\*\*([^*]+)\*\*[ \t]*$/;    // **発話者**
const ID_DIRECTION_RE = /^[-*+]\s+(.+)$/;        // - ト書き (**後ろに本文が要る**)
const ID_LINE_RE = /^<!--\s*id:\s*([0-9A-Za-z_-]+)\s*-->$/;
/* 画面への指示 `<!--cmd:名前 引数-->` (→ MdNameBalloon/SPEC.md「原稿からの指示」)。
 * **要素ではない**ので ID の付け先にならず、行 ID の「直前の要素に付く」判定も跨ぐ。
 * **中身は見ない** ―― 知らない名前かどうかを判断するのはアドオン側 (ホストが
 * 独自の指示を実装していることがあるため、ここで弾くと正しい原稿に色が付かない) */
const CMD_LINE_RE = /^<!--\s*cmd:\s*[a-z][a-z0-9_]*(\s[^]*)?-->$/;
const ID_CHOICE_RE = /^([0-9]|[1-9][0-9]*)\.[ \t]+(.*)$/;   // 1. 選択肢
const ID_CHOICE_BARE_RE = /^([0-9]|[1-9][0-9]*)\.[ \t]*$/;  // 本文の無い「0.」
const ID_CODE_ONLY_RE = /^`([^`]+)`$/;           // ページ効果 (見出し直後のコード行)

/* 原稿から「行 ID を配る対象」を**原稿の順に**取り出す (ページはまたぐ)。
 * 戻り値: [{ kind: "dialogue"|"telop"|"direction", line, line_end, id }]
 *   line / line_end … **0 始まり**の行番号。ID は line_end の**次の行**へ入る
 *   id … 既に付いている行 ID (無ければ "")
 *
 * 要素になるのは 3 種だけ。柱書き (### )・注釈 ({})・分岐行 (1. )・
 * 発話者宣言 (**名前**) は要素ではない (見た目を持たないか、別扱い)。 */
function collectItems(text) {
	var lines = splitLinesOf(text);
	// frontmatter (--- で始まるブロック) を読み飛ばす (判定は bodyStartOf 1 か所)
	var i = bodyStartOf(lines);
	var out = [];
	var inPage = false;
	var title = "";
	// **コードフェンスの中は原稿ではない** (行 ID も振らず、ページの境目にもしない)。
	// 閉じていなければ最後まで原稿ではない (name-spec MDNAME.md §1)。frontmatter の中は
	// 上で読み飛ばしてあるので、フェンスの判定は本文だけに効く
	var fence = fenceMapOf(lines, i);   // i = frontmatter の次の行
	// **付け先が無いあいだの行 ID は、いくつ並んでも、どの要素にも付けずに捨てる**。旗 1 つで持つ。
	// 立つのは 2 つの場面 (どちらも「直前の要素」へ**黙って付く**のを防ぐ):
	//  (1) 空のふきだしの後ろ (name-spec 3078bd5・6b84075、2026-10-01・02 作者判断)。空のふきだしは
	//      台詞にしないので「直前の要素」が前の台詞になり、黙ってそちらへ付く (前の台詞に ID が
	//      無ければ奪う)
	//  (2) ページ見出しの後ろ、最初の要素より前 (name-spec d3910e3、2026-10-02 作者判断)。
	//      ページの頭の要素を消して ID だけ残ったとき、**前のページの要素**へ黙って付く。
	//      ID は後ろにしか付かないので、次の台詞にも付かない。発話者の引き継ぎがページ見出しで
	//      終わるのとも揃う
	// **先勝ち (2 つ並べば後ろは捨てる) と同じく、要素の後ろに並ぶ行 ID は 1 まとまり**なので、
	// 1 つ捨てたあとの 2 つ目を前の要素に付けると、防いだはずの「黙って付く」がそのまま残る。
	// だから**行 ID では下ろさず**、要素 (台詞・ト書き・テロップ) を読んだときに下ろす
	// (その後ろの ID は別のまとまりなので)
	var noAttachTarget = false;
	while (i < lines.length) {
		if (fence.inside[i]) {
			i++;
			continue;
		}
		var t = markOf(lines[i]);
		if (t.indexOf("÷÷÷÷") === 0) {
			break; // 以降はメモ
		}
		// **ページ見出しは元の行で見る** (pageHeadingOf が自分で半角空白とタブだけ削る)
		if (pageHeadingId(lines[i]) !== null) {
			inPage = true;
			// ページ見出しの後、最初の要素より前の行 ID は、前のページの要素に付けない
			noAttachTarget = true;
			i++;
			// ページ効果: 見出しの**直後**にあるコードだけの行 (連続可)
			while (i < lines.length && ID_CODE_ONLY_RE.test(markOf(lines[i]))) {
				i++;
			}
			continue;
		}
		if (title === "" && t.indexOf("# ") === 0 && t.indexOf("## ") !== 0) {
			title = t.slice(2).trim();
			i++;
			continue;
		}
		if (!inPage) {
			i++;   // 最初のページ見出しより前は無視
			continue;
		}
		var m = t.match(ID_LINE_RE);
		if (m) {
			// **直前の要素に付く。先勝ち** (2 つ並んでも後ろは捨てる)。
			// **空のふきだしの後ろなら、いくつ並んでも捨てる** (どの要素にも付かない)。
			// 旗はここで下ろさない (2 つ目以降も同じまとまり)
			if (!noAttachTarget && out.length > 0 && out[out.length - 1].id === "") {
				out[out.length - 1].id = m[1];
			}
			i++;
			continue;
		}
		if (ID_TELOP_RE.test(t)) {   // テロップは発話者 (**...**) より先に見る
			// **`***` の連続をまとめて 1 つのテロップにする** (台詞の `>` と同じ規則)
			var telopStart = i;
			while (i < lines.length && ID_TELOP_RE.test(markOf(lines[i]))) {
				i++;
			}
			out.push({ kind: "telop", line: telopStart, line_end: i - 1, id: "" });
			noAttachTarget = false;
			continue;
		}
		if (ID_DIRECTION_RE.test(t)) {
			out.push({ kind: "direction", line: i, line_end: i, id: "" });
			noAttachTarget = false;
			i++;
			continue;
		}
		if (ID_CHOICE_RE.test(t) || ID_CHOICE_BARE_RE.test(t)) {
			i++;   // 分岐行は要素ではない
			continue;
		}
		if (ID_SPEAKER_RE.test(t)) {
			i++;   // 発話者宣言は次の台詞に付く情報で、それ自体は要素ではない
			continue;
		}
		if (t.indexOf(">") === 0) {
			// **`>` の連続をまとめて 1 つの台詞にする** (範囲の規則は dialogueRunEnd 1 か所)
			var start = i;
			i = dialogueRunEnd(lines, start, fence.inside);
			var block = { kind: "dialogue", line: start, line_end: i - 1, id: "" };
			if (isEmptyBalloon(lines, block)) {
				noAttachTarget = true;   // 要素にしない。直後の行 ID を捨てる旗を立てる
			} else {
				out.push(block);
				noAttachTarget = false;
			}
			continue;
		}
		i++;
	}
	return out;
}

/* ---- 行 ID を付ける ----
 *
 * 行 ID (`<!--id:a1b2c3-->`) は、**台詞を入れ替え・削除しても見た目の設定が
 * 付いてくる**ようにするための印 (→ 別リポジトリ manga-tools の
 * ClaudeCodeSession/AddTxt/.context/balloon_lineid_plan.md)。
 * ID の無い要素は MdNameBalloon の編集モードで動かしても**保存されない**のに、
 * 掴めて動くので気づけない。**書いた場所で付けるのがいちばん確実**なので、
 * ここ (Obsidian) にコマンドを置く。
 *
 * **保存のたびに自動では付けない** (発話者の収集とは違う判断)。speakers.md は
 * 書きかけの名前が混ざっても手で消せばよいが、**書きかけの行に振った ID は
 * 原稿に残り、そこへ設定が付いてしまう**。付けるのは作者が決めた瞬間だけにする。
 *
 * ID は **36 進 6 桁の小文字乱数**。連番にしない (位置を焼き込むと行 ID の
 * 目的そのものが無くなる)。 */

const ID_ASSIGN_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_ASSIGN_LENGTH = 6;
// ファイル内の既存 ID を集めるため (要素に付いていないものも拾って衝突を避ける)
const ID_ANY_RE = /<!--\s*id:\s*([0-9A-Za-z_-]+)\s*-->/g;

/* 使われていない行 ID を 1 つ作る。used は { id: true } で、作った ID も足す */
function makeLineId(used) {
	for (var tries = 0; tries < 1000; tries++) {
		var s = "";
		for (var k = 0; k < ID_ASSIGN_LENGTH; k++) {
			s += ID_ASSIGN_CHARS.charAt(
				Math.floor(Math.random() * ID_ASSIGN_CHARS.length));
		}
		if (!used[s]) {
			used[s] = true;
			return s;
		}
	}
	return "";   // ここまで来ることは実際上ない
}

/* 原稿から「どの行の後ろへ、どの ID を入れるか」の計画を立てる (**まだ書かない**)。
 * 戻り値: { inserts: [{ line_end, id }], duplicates: [id, ...] }
 *   inserts … **原稿の順**。書くときは**後ろから**入れること (前から入れると
 *             以降の行番号がずれる)
 *   duplicates … 同じ ID が 2 回以上使われている (コピペで起きる)。
 *             **直さずに報告だけする** — どちらを残すかは人が決めることで、
 *             機械が選ぶと**黙って別の要素へ設定が移る**
 *
 * 何度流しても増えない (既にある ID はそのまま)。 */
function planLineIds(text) {
	var items = collectItems(text);
	var used = {};
	var m;
	ID_ANY_RE.lastIndex = 0;
	while ((m = ID_ANY_RE.exec(text)) !== null) {
		used[m[1]] = true;
	}
	var seen = {};
	var duplicates = [];
	var inserts = [];
	for (var i = 0; i < items.length; i++) {
		var it = items[i];
		if (it.id !== "") {
			if (seen[it.id] && duplicates.indexOf(it.id) < 0) {
				duplicates.push(it.id);
			}
			seen[it.id] = true;
			continue;
		}
		var fresh = makeLineId(used);
		if (fresh === "") {
			continue;
		}
		seen[fresh] = true;
		inserts.push({ line_end: it.line_end, id: fresh });
	}
	return { inserts: inserts, duplicates: duplicates };
}

/* **貼り付けた文字列の行 ID を、その話に既にあるものなら新しい ID にする** (**複製は新しい ID**。
 * name-spec MDNAME.md §7・2026-10-03 作者判断)。ID は話 (1 ファイル) の中で一意で、コピーして貼ると
 * 同じ ID が 2 つの要素に付いてしまう。**切り取って貼る (移動) ときは元が消えているので、ID は保たれる**
 * (existingText に元が無いので、置き換えない)。別の話へ貼るときも同じ (その話に無ければ保つ)。
 *   pasted       貼る文字列
 *   existingText 貼り付け先の話の本文 (**貼り付けで置き換わる選択範囲は含めない**。貼ったあと消えるので、
 *                その中の ID は「既にある」ことにしない)
 * 戻り値: { text: 貼る文字列 (ID を置き換えたもの), renewed: 置き換えた数 }
 * 置き換えるのは**行 ID の行** (`<!--id:…-->` だけの行) の値だけ。新しい ID は makeLineId で、
 * 話の中の ID・貼った中の ID と重ならないもの。
 * **「話に既にある」のは、要素に付いた ID だけ** (collectItems。重なりの定義と同じ。MDNAME.md §7)。
 * ÷÷÷÷ 以降のメモ・コードフェンスの中・文中に書いてあるだけの ID の文字列、捨てられた ID は数えない
 * (数えると、メモに ID を書いただけで、別の話へ貼った ID まで変わる。2026-10-03 実機で踏んだ)。
 * **新しい ID を選ぶときは、書いてあるものすべてと重ならないようにする**。 */
function renewPastedIds(pasted, existingText) {
	var used = {};
	var m;
	ID_ANY_RE.lastIndex = 0;
	while ((m = ID_ANY_RE.exec(existingText)) !== null) {
		used[m[1]] = true;
	}
	var existing = {};                          // 「話に既にある」ID = 要素に付いた ID だけ
	var items = collectItems(existingText);
	for (var k = 0; k < items.length; k++) {
		if (items[k].id !== "") {
			existing[items[k].id] = true;
		}
	}
	ID_ANY_RE.lastIndex = 0;
	while ((m = ID_ANY_RE.exec(pasted)) !== null) {
		used[m[1]] = true;                      // 貼った中の ID とも重ならないようにする
	}
	// 改行は LF・CRLF・単独の CR のどれも行の区切り (MDNAME.md §1。貼る文字列は他のアプリから来ると CR のことがある)。
	// **区切りは捨てずに、そのまま残して**つなぎ直す (貼る文字列の改行を勝手に変えない)
	var parts = String(pasted).split(/(\r\n|\r|\n)/);   // 偶数番目が行、奇数番目が区切り
	var renewed = 0;
	for (var i = 0; i < parts.length; i += 2) {
		var mm = markOf(parts[i]).match(ID_LINE_RE);
		if (!mm || !existing[mm[1]]) {
			continue;
		}
		var fresh = makeLineId(used);
		if (fresh === "") {
			continue;
		}
		parts[i] = parts[i].replace(/(<!--\s*id:\s*)[0-9A-Za-z_-]+(\s*-->)/, "$1" + fresh + "$2");
		renewed++;
	}
	return { text: parts.join(""), renewed: renewed };
}

/* 行 ID の 1 行を組み立てる (アドオン側の MdNameParser.id_line と同じ形) */
function lineIdText(id) {
	return "<!--id:" + id + "-->";
}

/* ---- 行 ID を消す (name-spec f663950・MDNAME.md §7・2026-10-03 作者判断) ----
 * **消すのは作者がはっきり指示したときだけ**。文法は ID を消すことを禁じていないが、**消して付け直すと別の乱数の ID に
 * なり、Godot の style.json (ページ id と行 ID で引く) や翻訳のファイル (既定の言語と同じ ID で突き合わせる) との
 * 結び付きは戻らない**。だから確かめる手続を挟む (removeLineIds)。 */

/* 消す行を決める (**まだ消さない**)。text は原稿全体、fromLine〜toLine は範囲 (0 始まり・両端を含む。省略は話全体)。
 * 戻り値: { remove: [消す行番号 (昇順)], padded: 前後に全角空白などが付いて ID の行になっていない数 (残す),
 *           changes: [{ from: {line, ch}, to: {line, ch}, text }] (元の原稿の位置。1 つの編集にまとめて渡す),
 *           blankKept: 前後の台詞・テロップがつながらないよう空行を 1 つ残した数 }
 * 消すのは**原稿の範囲 (frontmatter・コードフェンスの中・÷÷÷÷ 以降を除く) の行 ID の行すべて**。要素に付いた ID も、
 * 付け先が無く捨てられている ID も (判定は collectItems と同じ markOf の行に ID_LINE_RE)。
 * **行ごと消して空行を残さない。** ただし**前後が同じ種類の連続した行 (台詞の `>` どうし・テロップどうし) なら、空行を 1 つ残す**
 * (ID の行が区切りだったとき、消すと 2 つの台詞が 1 つにつながって別の要素になる)。 */
function planRemoveIds(text, fromLine, toLine) {
	var lines = splitLinesOf(text);
	var start = bodyStartOf(lines);
	var fence = fenceMapOf(lines, start);
	var stop = cutLineOf(lines, fence.inside, start);
	var last = lines.length - 1;
	var lo = (fromLine === undefined || fromLine === null) ? 0 : Math.max(0, fromLine);
	var hi = (toLine === undefined || toLine === null) ? last : Math.min(last, toLine);
	var remove = [];
	var padded = 0;
	for (var i = start; i < stop; i++) {
		if (fence.inside[i] || i < lo || i > hi) {
			continue;
		}
		if (ID_LINE_RE.test(markOf(lines[i]))) {
			remove.push(i);
		} else if (ID_LINE_RE.test(lines[i].trim())) {
			padded++;   // 全角空白などが付いた行は、ID の行ではない (印の無い行)。残す
		}
	}
	function kindOf(raw) {
		var m = markOf(raw);
		return m.indexOf(">") === 0 ? "dialogue" : ID_TELOP_RE.test(m) ? "telop" : "";
	}
	var changes = [];
	var blankKept = 0;
	var k = 0;
	while (k < remove.length) {
		var a = remove[k];
		var b = a;
		while (k + 1 < remove.length && remove[k + 1] === b + 1) {
			k++;
			b = remove[k];
		}
		k++;
		var bLen = lines[b].length;
		if (a > 0 && b < last && kindOf(lines[a - 1]) !== "" && kindOf(lines[a - 1]) === kindOf(lines[b + 1])) {
			// 前後が同じ種類の連続行: 空行を 1 つ残す (行の中身だけ消す)
			changes.push({ from: { line: a, ch: 0 }, to: { line: b, ch: bLen }, text: "" });
			blankKept++;
		} else if (b < last) {
			changes.push({ from: { line: a, ch: 0 }, to: { line: b + 1, ch: 0 }, text: "" });
		} else if (a > 0) {
			// 最終行が ID の行: 直前の改行ごと消す (空行を残さない)
			changes.push({ from: { line: a - 1, ch: lines[a - 1].length }, to: { line: b, ch: bLen }, text: "" });
		} else {
			changes.push({ from: { line: 0, ch: 0 }, to: { line: b, ch: bLen }, text: "" });
		}
	}
	return { remove: remove, padded: padded, changes: changes, blankKept: blankKept };
}

/* 確認の画面。**既定はキャンセル** (Esc・閉じるでも消さない)。「削除する」を押したときだけ true を返す。
 * **クラスは呼び出し時に作る** (Modal は Obsidian が渡す。台本の obsidian のスタブには Modal が無い)。 */
function confirmRemoveIds(app, info) {
	return new Promise(function (resolve) {
		class ConfirmRemoveModal extends Modal {
			onOpen() {
				var el = this.contentEl;
				el.empty();
				el.createEl("h3", { text: "行 ID を消す" });
				el.createDiv({ text: "話: " + info.name });
				el.createDiv({ text: "範囲: " + info.rangeText });
				el.createDiv({ text: "消す行 ID: " + info.count + " 件" });
				if (info.padded > 0) {
					el.createDiv({ cls: "mdname-confirm-note",
						text: "（前後に全角空白などが付いて ID の行になっていない " + info.padded + " 行は残します）" });
				}
				el.createDiv({ cls: "mdname-confirm-warn",
					text: "スタイルや翻訳との結び付きは、付け直しても戻りません（付け直すと別の ID になります）。"
						+ "Ctrl+Z（Mac は Cmd+Z）で 1 回で元に戻せます。" });
				var row = el.createDiv({ cls: "mdname-confirm-buttons" });
				var cancel = row.createEl("button", { text: "キャンセル" });
				cancel.addEventListener("click", () => { this.close(); });
				var ok = row.createEl("button", { text: "削除する", cls: "mod-warning" });
				ok.addEventListener("click", () => { this.confirmed = true; this.close(); });
				cancel.focus();   // 既定はキャンセル (Enter を押しても消さない)
			}
			onClose() {
				this.contentEl.empty();
				resolve(this.confirmed === true);
			}
		}
		new ConfirmRemoveModal(app).open();
	});
}

/* ---- 発話者リスト (speakers.md) ----
 * 同じフォルダの speakers.md (1行1名) が発話者の一覧。Shift+Tab のピッカーは
 * このファイルを読む。並べ替え・削除・追加は手で編集してよい。
 *
 * **保存のたびに自動で集めるのはやめた** (2026-08-06・ユーザー判断)。
 * 自動保存は打鍵の途中でも走るので、**書きかけの名前** (「ヤマダ」と打つ途中の
 * 「ヤマ」など) が入る。**想像より頻度が高く**、一覧がノイズで埋まった。
 * 代わりに**作者が名前を確定させた瞬間だけ**登録する:
 *   - ピッカーで一覧に無い名前を打つと「登録して挿入」が出る (普段はこちら)
 *   - コマンド「この原稿の発話者を取り込む」(既存の原稿からまとめて集めるとき)
 * どちらも**作者の明示的な操作**なので、書きかけを拾いようがない。 */
const SPEAKERS_FILE = "speakers.md";

/* mdName 本文から発話者名 (名前@所属) を出現順・重複なしで集める。
 *
 * **着色・波線と同じ判定を使う** (speakerValidity。name-spec MDNAME.md §4.2)。
 * 以前はここだけ「直後の行が `>`」で判定していたので、**空行・行 ID・cmd・コメントを挟んだ発話者**
 * (着色では発話者の色になる行) が登録されず、**コードフェンスの中の見本の発話者**
 * (原稿ではない) が登録されていた。判定が機能ごとに違うことが食い違いの原因だったので、
 * **有効かどうかの判定は 1 か所**に寄せた。
 *   - 有効なのは、次に来る行が台詞のとき (空行・行 ID・cmd・コメント 1 行は飛ばして見る)
 *   - コードフェンスの中は原稿ではないので数えない。÷÷÷÷ 以降は対象外 (フェンスの中の ÷÷÷÷ は除く)
 *   - frontmatter の中は見ない */
function collectSpeakers(text) {
	var lines = splitLinesOf(text);
	var from = bodyStartOf(lines);
	var fence = fenceMapOf(lines, from);
	var stop = cutLineOf(lines, fence.inside, from);
	var names = [];
	for (var i = from; i < stop; i++) {
		if (fence.inside[i]) {
			continue;
		}
		var t = markOf(lines[i]);
		if (SPEAKER_RE.test(t) && speakerValidity(lines, i, stop).valid) {
			var name = t.replace(/^\*\*/, "").replace(/\*\*\s*$/, "");
			name = name.split(/[:：]/)[0].trim(); // acting を除く
			if (name !== "" && names.indexOf(name) < 0) {
				names.push(name);
			}
		}
	}
	return names;
}

/* 同じフォルダの speakers.md のパス */
function speakersPathFor(file) {
	var dir = file.parent ? file.parent.path : "";
	return dir === "" || dir === "/" ? SPEAKERS_FILE : dir + "/" + SPEAKERS_FILE;
}

/* ---- 記法入力の補助 (\ キーでドロップダウン) ----
 * 編集モードで \ (日本語キーボードの ¥・全角 ＼ も可) を打つと mdName の記法テンプレートを
 * ドロップダウンで選んで挿入できる (Obsidian の EditorSuggest。[[ のファイル候補と同じ仕組み)。
 * 新規の白紙ファイルでも使えるよう mdName 判定はせず全 .md で有効
 * (\ を打たない限り出ないので通常ノートへの実害はない)。
 * \ の後に続けて文字を打つと絞り込みできる (label / keys に部分一致)。 */
/* ---- 次のページ見出しを作る ----
 *
 * **直前のページ見出しの形を引き継いで番号だけ進める**。mdName のページ id は
 * 数字でなくてよく (`^##\s+[pP]\.(\S+)$`)、**節は id の接頭辞で表す**規約なので
 * (→ 別リポジトリ manga-tools の
 * ClaudeCodeSession/AddTxt/.context/handover.md「`## p.NNN` は mdName の背骨」)、
 * 接頭辞をそのまま残して末尾の数字だけを +1 すれば、漫画でもアプリでも通る。
 *
 *   001      → 002      **桁を保つ** (漫画のページは 0 詰めが基本)
 *   feat_1   → feat_2   接頭辞を引き継ぐ (節の中の次の項)
 *   feat.1   → feat.2
 *   002-003  → 004      見開きの次は**終端 + 1**
 *   (見出しが無い) → 001
 *
 * **末尾が数字でない id (`intro` など) からは作らない** ("" を返す)。
 * `intro_2` なのか `intro2` なのか決められないので、**推測して間違えるより
 * 手で打ってもらう** (呼び出し側は従来どおり `## p.` だけを入れる)。 */

const NEXT_TRAILING_RE = /^(.*?)(\d+)$/;
const NEXT_SPREAD_RE = /^(\d+)[-_](\d+)$/;

/* 数字を桁数を保って +1 する ("009" → "010"、"99" → "100") */
function bumpNumber(digits) {
	var n = String(parseInt(digits, 10) + 1);
	return n.length >= digits.length ? n
		: new Array(digits.length - n.length + 1).join("0") + n;
}

/* 原稿と行番号 (0 始まり) から「次のページ id」を作る。作れなければ "" */
function nextPageId(text, beforeLine) {
	var lines = splitLinesOf(text);
	var limit = (beforeLine === undefined || beforeLine === null)
		? lines.length : Math.min(beforeLine, lines.length);
	var last = "";
	for (var i = 0; i < limit; i++) {
		var id = pageHeadingId(lines[i]);
		if (id !== null) {
			last = id;
		}
	}
	if (last === "") {
		return "001";   // 1 枚目。漫画でもアプリでも無難な出発点
	}
	var sp = last.match(NEXT_SPREAD_RE);
	if (sp) {
		return bumpNumber(sp[2]);   // 見開きの次は終端 + 1
	}
	var m2 = last.match(NEXT_TRAILING_RE);
	if (!m2) {
		return "";      // 末尾が数字でない = 進め方を決められない
	}
	return m2[1] + bumpNumber(m2[2]);
}

// ページ見出しの項目だけ中身を差し替えるので、ラベルで引けるようにしておく
const PAGE_SNIPPET_LABEL = "ページ見出し";
const MDNAME_SNIPPETS = [
	// 発話者の直後は台詞で確定なので、次行の > も一緒に挿入する (カーソルは発話者位置)
	{ label: "発話者", example: "**名前@所属:acting** (+次行 >)", keys: ["speaker", "hatsuwasha", "name"],
		insert: "****\n>", cursor: 2 },
	{ label: "台詞", example: ">台詞", keys: ["serifu", "dialogue", "quote"],
		insert: ">", cursor: 1 },
	{ label: "テロップ", example: "***テロップ***", keys: ["telop"],
		insert: "******", cursor: 3 },
	{ label: "注釈", example: "{注釈}", keys: ["annotation", "chushaku", "memo"],
		insert: "{}", cursor: 1 },
	{ label: "柱書き", example: "### 柱書き", keys: ["scene", "hashira"],
		insert: "### ", cursor: 4 },
	{ label: "ト書き", example: "- ト書き", keys: ["togaki", "direction"],
		insert: "- ", cursor: 2 },
	{ label: "章見出し", example: "# 第一章", keys: ["chapter", "shou", "wasuu"],
		insert: "# ", cursor: 2 },
	{ label: PAGE_SNIPPET_LABEL, example: "## p.001", keys: ["page", "p", "midashi"],
		insert: "## p.", cursor: 5 },
	{ label: "ルビ", example: "|漢字<かんじ>|", keys: ["ruby", "rubi"],
		insert: "|<>|", cursor: 1 },
	// 複数行の挿入。cursor は1行目内のオフセット (setCursor は挿入開始行で計算される)
	{ label: "分岐ブロック", example: "0. 導入文 / 1. 選択肢 [[リンク]]", keys: ["bunki", "branch", "choice"],
		insert: "0. \n1. [[]]\n2. [[]]", cursor: 3 },
	// 画面への指示 (→ MdNameBalloon/SPEC.md「原稿からの指示」)。**ここに置いたのは、
	// 記法の入り口を1つに保つため** — `<` で開く専用のサジェストも考えたが、
	// **`<` はルビの開始文字**なのでルビを打つたびに候補が出るうえ、
	// 文字トリガーは日本語入力の変換候補とぶつかる (発話者候補を `\` から
	// Shift+Tab へ移したのと同じ理由)。
	// **一覧を外部ファイルにはしない** — コマンドを決めるのはアドオンとホストで、
	// 発話者と違って**作者の作品データではない**。写しの置き場所を増やすと
	// 定義が3箇所になる。増えすぎたらそのとき切り出す
	{ label: "指示", example: "<!--cmd:clear--> (ふきだしを区切る)",
		keys: ["cmd", "clear", "command", "shiji", "kugiri"],
		insert: "<!--cmd:clear-->", cursor: 16 },
];

/* ---- 発話者ピッカー (Shift+Tab) ----
 *
 * **文字ではなく打鍵で開く**。以前は `\` ＼ ¥ ￥ の文字をトリガーにしていたが、
 * **iPadOS / macOS の日本語入力では変換候補が出てしまい扱いにくい**
 * (2026-08-06・ユーザー要望)。
 *
 * **`EditorSuggest` では実現できない**のがポイント。あちらは
 * 「カーソルの前の文字」を見て開く仕組みなので、**文字を挿入しない打鍵は拾えない**。
 * そこで CodeMirror のキーマップで Shift+Tab を受け、`SuggestModal` を開く。
 *
 * **mdName の原稿でないときは何もしない** (false を返して既定の動作＝
 * リストのアウトデントへ譲る)。通常ノートで Shift+Tab が効かなくなると困る。 */

class SpeakerPickerModal extends SuggestModal {
	constructor(app, names, onPick) {
		super(app);
		this.names = names;
		this.onPick = onPick;
		this.setPlaceholder("発話者を選ぶ / 新しい名前を打って登録");
	}
	/* 候補は { name, isNew } の形。**一覧に無い名前を打ったら「登録して挿入」を出す**
	 * — ここが**発話者を増やす普段の経路**。作者が打って選んだ名前なので、
	 * 保存のたびに集めていた頃のような**書きかけの取りこぼしが起きない**。 */
	getSuggestions(query) {
		var raw = String(query || "").trim();
		var q = raw.toLowerCase();
		var hits = this.names.filter(function (n) {
			return q === "" || n.toLowerCase().indexOf(q) >= 0;
		}).map(function (n) { return { name: n, isNew: false }; });
		// 完全一致が無いときだけ「登録」を出す (同じ名前を二重に登録させない)
		var exact = this.names.some(function (n) { return n === raw; });
		if (raw !== "" && !exact) {
			hits.push({ name: raw, isNew: true });
		}
		return hits;
	}
	renderSuggestion(item, el) {
		el.createDiv({ text: item.isNew ? "「" + item.name + "」を登録して挿入" : item.name,
			cls: "mdname-suggest-label" });
		el.createDiv({
			text: item.isNew ? "speakers.md へ追記します"
				: "**" + item.name + "** (+次行 >)",
			cls: "mdname-suggest-example" });
	}
	onChooseSuggestion(item) {
		this.onPick(item.name, item.isNew);
	}
}

/* Shift+Tab のキーマップ。**最優先で登録する** (Prec.highest) —
 * 既定のアウトデントより先に受け取る必要があるため。 */
function speakerPickerKeymap(plugin) {
	return Prec.highest(keymap.of([{
		key: "Shift-Tab",
		run: function (view) {
			if (!plugin.settings.suggestShiftTab) {
				return false;
			}
			var info = view.state.field(editorInfoField, false);
			var file = info ? info.file : null;
			if (!file || file.extension !== "md" || !info.editor) {
				return false;
			}
			var head = view.state.doc.sliceString(0,
				Math.min(view.state.doc.length, DETECT_SLICE));
			if (!MDNAME_DETECT_RE.test(head)) {
				return false;   // 通常ノートでは既定の動作 (アウトデント) へ譲る
			}
			plugin.openSpeakerPicker(info.editor, file);
			return true;
		},
	}]));
}

class MdNameSuggest extends EditorSuggest {
	constructor(app, plugin) {
		super(app);
		this.plugin = plugin;
	}
	onTrigger(cursor, editor, file) {
		if (file && file.extension !== "md") {
			return null;
		}
		var before = editor.getLine(cursor.line).slice(0, cursor.ch);
		// タブ文字からカーソルまで (空白を含まない) をトリガー+絞り込み文字列にする。
		// **文字で開くのは記法テンプレートだけ**。発話者候補は Shift+Tab の打鍵で開く
		// (文字だと日本語入力の変換候補とぶつかる → speakerPickerKeymap)
		var m = before.match(/(\t)([^\s]*)$/);
		if (!m) {
			return null;
		}
		if (!this.plugin.settings.suggestTab) {
			return null;
		}
		this.triggerMode = "snippet";
		return {
			start: { line: cursor.line, ch: cursor.ch - m[0].length },
			end: cursor,
			query: m[2],
		};
	}
	async getSuggestions(context) {
		var q = context.query.toLowerCase();
		if (this.triggerMode === "speaker") {
			// 発話者候補: 同じフォルダの speakers.md (1行1名) から。名前確定済みなので
			// 台詞行まで挿入し、カーソルは2行目の > の後 (cursorLine=1, cursor=絶対桁)
			var items = [];
			if (context.file) {
				var sp = this.app.vault.getAbstractFileByPath(speakersPathFor(context.file));
				if (sp) {
					var text = await this.app.vault.cachedRead(sp);
					var lines = text.split("\n");
					for (var i = 0; i < lines.length; i++) {
						var n = lines[i].trim();
						if (n === "" || (q !== "" && n.toLowerCase().indexOf(q) < 0)) {
							continue;
						}
						items.push({
							label: "発話者 " + n, example: "**" + n + "** (+次行 >)",
							insert: "**" + n + "**\n>", cursor: 1, cursorLine: 1,
						});
					}
				}
			}
			return items;
		}
		var hits = MDNAME_SNIPPETS.filter(function (s) {
			return q === "" || s.label.indexOf(q) >= 0 ||
				s.keys.some(function (k) { return k.indexOf(q) >= 0; });
		});
		// **ページ見出しだけは直前の見出しから作る** (接頭辞を引き継いで番号を進める)。
		// 作れないときは従来どおり `## p.` を入れてカーソルを末尾へ置く
		var next = context.editor
			? nextPageId(context.editor.getValue(), context.start.line) : "";
		if (next === "") {
			return hits;
		}
		return hits.map(function (s) {
			if (s.label !== PAGE_SNIPPET_LABEL) {
				return s;
			}
			var ins = "## p." + next;
			return { label: s.label, example: ins, keys: s.keys,
				insert: ins, cursor: ins.length };
		});
	}
	renderSuggestion(item, el) {
		el.createDiv({ text: item.label, cls: "mdname-suggest-label" });
		el.createDiv({ text: item.example, cls: "mdname-suggest-example" });
	}
	selectSuggestion(item) {
		var ctx = this.context;
		if (!ctx) {
			return;
		}
		ctx.editor.replaceRange(item.insert, ctx.start, ctx.end);
		if (item.cursorLine) {
			// 複数行挿入で2行目以降にカーソルを置く (cursor は行内の絶対桁)
			ctx.editor.setCursor({ line: ctx.start.line + item.cursorLine, ch: item.cursor });
		} else {
			ctx.editor.setCursor({ line: ctx.start.line, ch: ctx.start.ch + item.cursor });
		}
	}
}

/* 設定画面: サジェスト呼び出しキー (\ 系 / Tab) の On/Off */
class MdNameSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display() {
		var el = this.containerEl;
		el.empty();
		var plugin = this.plugin;
		new Setting(el)
			.setName("Tab キーで記法サジェストを開く")
			.setDesc("タブ文字の入力で mdName 記法テンプレートのドロップダウンを開きます (箇条書き行では Obsidian のインデント操作が優先されます)。")
			.addToggle(function (t) {
				t.setValue(plugin.settings.suggestTab).onChange(async function (v) {
					plugin.settings.suggestTab = v;
					await plugin.saveData(plugin.settings);
				});
			});
		new Setting(el)
			.setName("Shift+Tab で発話者候補を開く")
			.setDesc("同じフォルダの speakers.md を元にした発話者候補 (**名前** + 次行 >) を開きます。"
				+ "mdName の原稿でないときは、Shift+Tab は本来の動き (アウトデント) のままです。")
			.addToggle(function (t) {
				t.setValue(plugin.settings.suggestShiftTab).onChange(async function (v) {
					plugin.settings.suggestShiftTab = v;
					await plugin.saveData(plugin.settings);
				});
			});
	}
}

module.exports = class MdNameHighlightPlugin extends Plugin {
	async onload() {
		var saved = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		// **古い設定を引き継ぐ**。`\` で開く設定 (suggestBackslash) を切っていた人は、
		// 名前が変わったせいで Shift+Tab が勝手に有効になる — 切った意思を尊重する
		if (saved && saved.suggestShiftTab === undefined
				&& saved.suggestBackslash !== undefined) {
			this.settings.suggestShiftTab = saved.suggestBackslash;
		}
		this.registerEditorExtension(mdnameViewPlugin);   // 編集/ライブプレビュー
		this.registerMarkdownPostProcessor(readingPostProcess);  // 閲覧モード
		this.registerEditorSuggest(new MdNameSuggest(this.app, this)); // Tab 記法入力補助
		this.registerEditorExtension(speakerPickerKeymap(this));       // Shift+Tab 発話者
		this.addSettingTab(new MdNameSettingTab(this.app, this));
		// **貼り付けた行 ID が、その話に既にあれば新しい ID にする** (複製は新しい ID。renewPastedIds)
		this.registerEvent(this.app.workspace.on("editor-paste", (evt, editor, info) => {
			this.onEditorPaste(evt, editor, info);
		}));
		// **行 ID を付ける** (コマンドパレット)。**保存時の自動付与はしない** —
		// 書きかけの行に振った ID は原稿に残り、そこへ設定が付いてしまう
		this.addCommand({
			id: "assign-line-ids",
			name: "行 ID を付ける",
			editorCallback: (editor, view) => {
				this.assignLineIds(editor);
			},
		});
		// **行 ID を消す**。既定のホットキーは付けない (「次のページ見出しを入れる」と同じ理由。消すのは作者が
		// はっきり指示したときだけで、確認の画面を挟む)
		this.addCommand({
			id: "remove-line-ids",
			name: "行 ID を消す",
			editorCallback: (editor, view) => {
				this.removeLineIds(editor, view);
			},
		});
		// **発話者の取り込みはコマンドから**。保存のたびに集めるのはやめた
		// (書きかけの名前が入るため → 発話者リストの節)
		// **次のページ見出しを入れる**。既定のホットキーは付けない —
		// Ctrl+Tab は Obsidian のタブ切り替えに使われているのが普通で、
		// **プラグインが黙って奪うと普段の操作が壊れる**。割り当てるかは
		// 設定 → ホットキー で作者が決める (衝突もそこで見える)
		this.addCommand({
			id: "insert-next-page-heading",
			name: "次のページ見出しを入れる",
			editorCallback: (editor) => {
				this.insertNextPageHeading(editor);
			},
		});
		this.addCommand({
			id: "import-speakers",
			name: "この原稿の発話者を取り込む",
			editorCallback: (editor, view) => {
				this.importSpeakers(view ? view.file : null);
			},
		});
	}

	/* 発話者ピッカーを開き、選んだら `**名前**` + 次行 `>` を挿入する。
	 * カーソルは**台詞の入力位置** (`>` の後) へ置く (名前はもう確定しているので)。 */
	async openSpeakerPicker(editor, file) {
		var names = [];
		var sp = this.app.vault.getAbstractFileByPath(speakersPathFor(file));
		if (sp) {
			var text = await this.app.vault.cachedRead(sp);
			names = text.split("\n").map(function (s) { return s.trim(); })
				.filter(function (s) { return s !== ""; });
		}
		// **一覧が空でも開く**。名前を打って登録できるので、ここで止めると
		// 最初の 1 人を登録する手段が無くなる (speakers.md を手で作る羽目になる)
		new SpeakerPickerModal(this.app, names, (name, isNew) => {
			var at = editor.getCursor();
			editor.replaceRange("**" + name + "**\n>", at, at);
			editor.setCursor({ line: at.line + 1, ch: 1 });
			if (isNew) {
				// **挿入を先にする**。登録の書き込みを待つあいだ画面が止まらない
				this.addSpeakers(file, [name]).then(function (added) {
					if (added.length > 0) {
						new Notice("発話者「" + name + "」を登録しました");
					}
				});
			}
		}).open();
	}

	/* 貼り付けの取り込み。貼る文字列に行 ID があり、それが**この話に既にあれば**、貼った側を新しい ID にして
	 * 貼る (元の ID は保つ)。**切り取って貼る (移動) は元が消えているので保たれる**。mdName の話だけ
	 * (ページ見出しがある .md)。置き換えが要らないときは何もしない (Obsidian の通常の貼り付けに任せる)。 */
	onEditorPaste(evt, editor, info) {
		if (evt.defaultPrevented) {
			return;
		}
		var file = info && info.file ? info.file : null;
		if (file && file.extension !== "md") {
			return;
		}
		var pasted = evt.clipboardData ? evt.clipboardData.getData("text/plain") : "";
		if (!pasted || pasted.indexOf("id:") < 0) {
			return;
		}
		var doc = editor.getValue();
		if (!MDNAME_DETECT_RE.test(doc.slice(0, DETECT_SLICE))) {
			return;
		}
		// 貼り付けで置き換わる選択範囲の中の ID は、貼ったあと消える (= 既にあることにしない)
		var from = editor.posToOffset(editor.getCursor("from"));
		var to = editor.posToOffset(editor.getCursor("to"));
		var rest = doc.slice(0, Math.min(from, to)) + doc.slice(Math.max(from, to));
		var r = renewPastedIds(pasted, rest);
		if (r.renewed === 0) {
			return;
		}
		evt.preventDefault();
		editor.replaceSelection(r.text);
		new Notice("貼り付けた行 ID のうち " + r.renewed + " 件は、この話に既にあったので新しい ID にしました");
	}

	/* 行 ID を消す。範囲: 選択があればその中 (選択が掛かっている行)、無ければ話全体。
	 * 確認の画面を出し、「削除する」を押したときだけ、**1 つの編集**で消す (Ctrl+Z 1 回で全部戻る)。 */
	async removeLineIds(editor, view) {
		var text = editor.getValue();
		if (!MDNAME_DETECT_RE.test(text.slice(0, DETECT_SLICE))) {
			new Notice("mdName の原稿ではありません (## p.001 の見出しがある .md が対象)");
			return;
		}
		var fromLine = null;
		var toLine = null;
		var rangeText = "話全体";
		if (editor.somethingSelected()) {
			var f = editor.getCursor("from");
			var t = editor.getCursor("to");
			fromLine = f.line;
			// 選択の終わりが行頭 (ch 0) なら、その行には掛かっていない
			toLine = (t.ch === 0 && t.line > f.line) ? t.line - 1 : t.line;
			rangeText = "選択範囲 (" + (fromLine + 1) + "〜" + (toLine + 1) + " 行目)";
		}
		var plan = planRemoveIds(text, fromLine, toLine);
		if (plan.remove.length === 0) {
			new Notice("消す行 ID はありません (" + rangeText + ")"
				+ (plan.padded > 0 ? "。前後に全角空白などが付いた " + plan.padded + " 行は ID の行ではないので残します" : ""));
			return;
		}
		var name = view && view.file ? view.file.basename : "(この話)";
		var yes = await confirmRemoveIds(this.app, {
			name: name, rangeText: rangeText, count: plan.remove.length, padded: plan.padded,
		});
		if (!yes) {
			return;
		}
		// 確認のあいだに原稿が変わっていたら、消さない (別の行を消さないため)
		var again = planRemoveIds(editor.getValue(), fromLine, toLine);
		if (again.remove.join(",") !== plan.remove.join(",")) {
			new Notice("確認のあいだに原稿が変わりました。もう一度やり直してください");
			return;
		}
		editor.transaction({ changes: plan.changes });   // 1 つのまとまった編集 = Ctrl+Z 1 回で戻る
		new Notice("行 ID を " + plan.remove.length + " 件消しました (Ctrl+Z で戻せます)"
			+ (plan.padded > 0 ? " / 全角空白などが付いた " + plan.padded + " 行は残しました" : "")
			+ (plan.blankKept > 0 ? " / 前後の台詞がつながらないよう空行を " + plan.blankKept + " か所残しました" : ""));
	}

	/* 開いている原稿の、行 ID を持たない要素に ID を付ける (コマンドから呼ぶ)。
	 *
	 * **後ろから入れる**のが要点。前から入れると以降の行番号がずれる。
	 * `editor.replaceRange` を使うので**取り消し (Ctrl+Z) が効く**し、
	 * ファイルを丸ごと置き換えないので**カーソルも飛ばない**。
	 *
	 * **重複した ID は直さず報告するだけ**。どちらを残すかは人が決めることで、
	 * 機械が選ぶと**黙って別の要素へ設定が移る**。 */
	assignLineIds(editor) {
		var text = editor.getValue();
		if (!MDNAME_DETECT_RE.test(text.slice(0, DETECT_SLICE))) {
			new Notice("mdName の原稿ではありません (## p.001 の見出しがある .md が対象)");
			return;
		}
		var plan = planLineIds(text);
		if (plan.inserts.length === 0 && collectItems(text).length === 0) {
			// **着色は通るのに要素が 0** = ページ見出しの形が本家と食い違っている
			// (全角の ｐ．００１ や `##` 直後の空白無しなど)。黙って「0 件」と
			// 言われても原因が分からないので、いちばんありそうな理由を添える
			new Notice("要素が見つかりません。ページ見出しを半角の「## p.001」"
				+ "の形にしてください");
			return;
		}
		var lastLine = editor.lastLine();
		for (var k = plan.inserts.length - 1; k >= 0; k--) {
			var one = plan.inserts[k];
			var idLine = lineIdText(one.id);
			if (one.line_end >= lastLine) {
				// 最終行の要素: 行を足す先が無いので、行末へ改行ごと足す
				var end = { line: lastLine, ch: editor.getLine(lastLine).length };
				editor.replaceRange("\n" + idLine, end, end);
			} else {
				var at = { line: one.line_end + 1, ch: 0 };
				editor.replaceRange(idLine + "\n", at, at);
			}
		}
		var msg = plan.inserts.length === 0
			? "すべての要素に行 ID があります"
			: "行 ID を " + plan.inserts.length + " 件付けました";
		if (plan.duplicates.length > 0) {
			msg += " / **重複した ID が " + plan.duplicates.length
				+ " 件あります**: " + plan.duplicates.join(", ");
		}
		new Notice(msg);
	}

	/* カーソルの位置へ次のページ見出しを入れる。**直前の見出しの形を引き継ぐ**
	 * (`feat_1` の後なら `## p.feat_2`、`001` の後なら `## p.002`)。
	 * 末尾が数字でない id からは作れないので、そのときは `## p.` だけ入れて
	 * カーソルを末尾へ置く (推測して間違えるより手で打ってもらう)。 */
	insertNextPageHeading(editor) {
		var at = editor.getCursor();
		var next = nextPageId(editor.getValue(), at.line);
		var text = "## p." + next;
		editor.replaceRange(text, at, at);
		editor.setCursor({ line: at.line, ch: at.ch + text.length });
	}

	/* 開いている原稿の発話者を speakers.md へ未登録分だけ取り込む (コマンドから)。
	 * **既存の原稿からまとめて集めるためのもの**で、普段の登録はピッカーで行う。
	 * 指示した瞬間だけ走るので、書きかけの名前を拾う心配がない。 */
	async importSpeakers(file) {
		if (!file || file.extension !== "md" || file.name === SPEAKERS_FILE) {
			new Notice("mdName の原稿を開いてから実行してください");
			return;
		}
		var text = await this.app.vault.cachedRead(file);
		if (!MDNAME_DETECT_RE.test(text.slice(0, DETECT_SLICE))) {
			new Notice("mdName の原稿ではありません (## p.001 の見出しがある .md が対象)");
			return;
		}
		var added = await this.addSpeakers(file, collectSpeakers(text));
		new Notice(added.length === 0
			? "新しい発話者はありませんでした"
			: "発話者を " + added.length + " 名登録しました: " + added.join("、"));
	}

	/* speakers.md へ未登録の名前だけ追記する。戻り値 = 実際に足した名前。
	 * **1 行 1 名で末尾へ足すだけ**。並べ替えや整理は作者が手でやる前提
	 * (機械が並べ替えると、手で付けた順序 = 登場順などの意図を壊す)。 */
	async addSpeakers(file, names) {
		if (!names || names.length === 0) {
			return [];
		}
		var spPath = speakersPathFor(file);
		var spFile = this.app.vault.getAbstractFileByPath(spPath);
		var existingText = spFile ? await this.app.vault.read(spFile) : "";
		var existing = existingText.split("\n").map(function (s) { return s.trim(); });
		var added = names.filter(function (n) {
			return n !== "" && existing.indexOf(n) < 0;
		});
		if (added.length === 0) {
			return [];
		}
		var out = existingText;
		if (out !== "" && !out.endsWith("\n")) {
			out += "\n";
		}
		out += added.join("\n") + "\n";
		if (spFile) {
			await this.app.vault.modify(spFile, out);
		} else {
			await this.app.vault.create(spPath, out);
		}
		return added;
	}
};
