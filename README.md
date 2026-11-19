# mdName Highlight

An Obsidian plugin for writing manga scripts ("name") in the **mdName** format —
Markdown with page headings such as `## p.001`, used by
[txt2mdp](https://himikokura.net/CatFoodEater/txt2mdp/) to lay out pages for FireAlpaca.

## English summary

- **Colors each kind of line** in notes that contain a `## p.001`-style page heading:
  dialogue (`>`), speakers (`**Name**`), captions (`***text***`), stage directions (`- `),
  scene headings (`### `), annotations (`{ }`), branch lines (`1. `) and memos after `÷÷÷÷`.
  Ordinary notes without a page heading are left untouched.
- **Marks each page heading with a thin rule** (and a small "見開き" label for two-page spreads),
  so page headings stand out from the episode title (`# `).
- **Underlines likely mistakes** with a wavy line in the editor (hover for the reason):
  malformed page headings, duplicate page ids, unclosed code fences, a speaker line not followed
  by dialogue, and empty speech balloons.
- **Line IDs** (`<!--id:a1b2c3-->`) for keeping balloon styles attached to lines in the
  companion Godot add-on: commands to add or remove them, and copied IDs are renewed on paste
  so that one note never holds the same ID twice.
- **Input helpers**: Tab opens a list of mdName templates; Shift+Tab opens a speaker picker
  based on `speakers.md` in the same folder.

The user interface and the rest of this README are in Japanese.

### Disclosures

- **No network access**, no telemetry, no account, no ads.
- The plugin **only changes files inside your vault, and only when you ask it to**:
  the note you are editing (the commands "add line IDs", "remove line IDs", "insert the next
  page heading", and pasting text that contains line IDs) and `speakers.md` in the same folder
  as the note (when you register a speaker).
- No Node.js or Electron APIs are used; it also works on mobile (checked on iPad).

---

## 何をするプラグインか

txt2mdp の **mdName 書式**（Markdown で書くネームの書式）を、Obsidian で書きやすく・
読みやすくするプラグインです。書式そのものの説明は、txt2mdp と NameTools のマニュアル
（`nameformat.md`）を見てください。

## 対象の自動判定

mdName は素の Markdown なので、vault の**ふつうのノートを誤って着色しないよう**、
**ページ見出し（`## p.001` の形。全角も可）を含む `.md` だけ**を対象にします。
設定は要りません。ページ見出しの無いノートには何もしません。

## 着色（文字色だけ・背景なし）

| 要素 | 表示 |
|---|---|
| `# 話数` | 基本の文字色・太字（題の見た目） |
| `## p.001` | 基本の文字色・太字。**上に細い罫線**、見開き（`## p.002-003`）は行末に小さく「見開き」 |
| `### 柱書き` | 黄色系（ト書きと同じ色） |
| `>台詞` | 緑系（`>` が続く行は 1 つの台詞） |
| `**発話者[@所属][:acting]**` | 青灰系・太字（次に来る行が台詞のときだけ） |
| `***テロップ***` | 紫系（閲覧ビューでは【…】で囲む） |
| `{注釈}` | 橙系 |
| `- ト書き`（`*` `+` も可。折り返した続きの行も同じ色） | 黄色系 |
| 分岐 `0. どうする？` / `1. 逃げる [[話#p.002]]` | シアン系 |
| 指示 `<!--cmd:clear-->` | 桃色系（はっきり出す） |
| 行 ID `<!--id:a1b2c3-->` | 薄く小さく（隠さない） |
| その他の地の文 | 灰色 |
| `÷÷÷÷` 以降のメモ | 薄い灰色 |
| ルビ `<…>`・`|親文字<よみ>|` | 行の色のまま少し薄く |

ライト・ダークの両テーマに合わせてあります。**原稿ではない範囲**（先頭の frontmatter・
コードフェンスの中・`÷÷÷÷` 以降）は、着色・知らせ・行 ID の対象外です。

## 書き間違いの知らせ（波線）

編集ビューで、次の行に**赤い波線**が付きます。**マウスを載せると理由が出ます**。
打っている途中の行には出しません。文字の色は変えません。

- **崩れたページ見出し**: `##p.001`（空白が無い）・全角の `## ｐ．００１`・見出しの中の全角空白や
  NBSP（Mac で Option を押したまま空白を打つと入る、見えない空白）・後ろに付いた語など。
  差の誤った見開き（`## p.002-004`）、打ち間違いらしい id も知らせます
- **同じ id のページ見出し**（2 つ目以降）
- **閉じていないコードフェンス**（そこから最後まで原稿として読まれません）
- **次が台詞でない発話者の行**（空行・行 ID・指示・1 行のコメントは飛ばして見ます）
- **空のふきだし**（`>` だけの台詞）

`#` が 1 つの行は話の題の印です。`# p.014-015` のように書くとページ見出しにならないので、
ページ見出しの罫線が付かないことで見分けてください。

## 入力の補助

- **Tab**: mdName の記法の雛形（発話者・台詞・テロップ・注釈・柱書き・ト書き・話数・
  ページ見出し・ルビ・分岐・指示）を一覧から選んで入れます。続けて文字を打つと絞り込めます。
  ページ見出しは、**直前の見出しの番号を 1 つ進めたもの**が入ります（`## p.009` → `## p.010`、
  `## p.002-003` → `## p.004`、`## p.feat_1` → `## p.feat_2`）
- **Shift+Tab**: 同じフォルダの `speakers.md`（1 行に 1 名）から発話者を選んで、
  `**名前**` と次の行の `>` を入れます。一覧に無い名前を打つと、その場で登録できます
- どちらも、設定で個別に切れます（既定はどちらも有効）。mdName の原稿でないノートでは、
  Shift+Tab は本来の動き（インデントを戻す）のままです

## コマンド

既定のホットキーは付けていません。使いたいキーは 設定 → ホットキー で割り当ててください。

| コマンド | すること |
|---|---|
| **行 ID を付ける** | ID の無い台詞・テロップ・ト書きの次の行に `<!--id:…-->` を入れます。既にある ID はそのままで、何度実行しても増えません。同じ ID が 2 か所にあれば、直さずに知らせます |
| **行 ID を消す** | 選択範囲（選択が無ければ話全体）の行 ID の行を消します。**確認の画面が出て、既定はキャンセル**です。Ctrl+Z（Mac は Cmd+Z）1 回で元に戻せます |
| **次のページ見出しを入れる** | Tab の雛形と同じ、番号を進めたページ見出しを入れます |
| **この原稿の発話者を取り込む** | 開いている原稿の発話者（`名前@所属`）を、まとめて `speakers.md` に足します |

## 行 ID

行 ID（`<!--id:a1b2c3-->`）は、台詞を入れ替えたり消したりしても、**ふきだしの位置や形の
設定が付いてくる**ようにするための印です（Godot のアドオン MdNameBalloon が、`style.json` に
行 ID をキーにして保存します）。

- 付くのは**台詞・テロップ・ト書き**の 3 種です
- **ID は 1 つの話（ファイル）の中で重ならないこと**。ID の行ごと移動したもの（切り取って貼る）は
  ID を保ちます。**コピーして貼ったときは、貼った ID がその話に既にあれば、貼った側を新しい ID に
  します**（通知が出ます）。別の話へ貼るときは保ちます
- **消して付け直すと別の ID になり、設定や翻訳との結び付きは戻りません**。「行 ID を消す」は
  そのために確認の画面を挟んでいます
- 保存のたびに自動で付けることはしません（書きかけの行に付いた ID が原稿に残るため）

## 閲覧ビュー

完成のイメージを確かめるために、閲覧ビューでは次を隠します: `÷÷÷÷` 以降のメモ・注釈・
記法に当てはまらない地の文・先頭のプロパティ（frontmatter）。編集ビューではすべて表示・編集できます。
テロップは【…】、発話者の所属は ＜…＞ で表示します。分岐は、選択肢とリンクのあいだに「 : 」を入れ、
`0.` がリンクだけの行（無条件で進む行）は番号を隠して「→」を付けます。

## インストール

- **コミュニティプラグイン**（公開後）: 設定 → コミュニティプラグイン → 閲覧 で
  「mdName Highlight」を探して入れます
- **手動**: vault の `.obsidian/plugins/mdname-highlight/` に、リリースの `main.js`・`manifest.json`・
  `styles.css` を置き、設定 → コミュニティプラグイン で有効にします

## ライセンス

MIT No Attribution（MIT-0）。`LICENSE` を見てください。
