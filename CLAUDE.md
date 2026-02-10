# CLAUDE.md - AI Assistant Guide for calendar-peering-gas

## プロジェクト概要

Google Apps Script (GAS) による**カレンダーピアリング**ツール。仕事（Work）と私生活（Life）の2つのGoogleカレンダーを双方向に接続し、プライバシーに配慮しながらスケジュールを共有する。

- **言語:** JavaScript (Google Apps Script V8ランタイム)
- **タイムゾーン:** Asia/Tokyo
- **外部依存:** なし（純粋なGAS API のみ）
- **ライセンス:** MIT

## リポジトリ構成

```
calendar-peering-gas/
├── Code.js              # アプリケーション全体のソースコード（単一ファイル）
├── appsscript.json      # GASマニフェスト（ランタイム・TZ設定）
├── README.md            # ユーザー向けドキュメント（日本語）
├── LICENSE              # MITライセンス
├── .gitignore           # .clasp.json等のセキュリティ除外
└── .claspignore         # CLASPデプロイ時の除外ルール
```

**重要:** `.clasp.json` と `.clasprc.json` はクレデンシャルを含むため `.gitignore` で除外されている。これらを絶対にコミットしないこと。

## アーキテクチャと主要関数

### エントリーポイント

- **`main()`** - 同期サイクルのメインエントリーポイント。GASトリガーから呼び出される
- **`myFunction()`** - `main()` のラッパー（GASエディタのデフォルト実行用）

### コア関数

| 関数 | 行 | 役割 |
|------|-----|------|
| `loadConfig()` | 58 | Script Propertiesから14+の設定を読み込み、デフォルト値を適用 |
| `syncDirection(sourceId, targetId, options)` | 89 | 双方向同期のコアロジック（Upsert + Delete） |
| `createTargetEvent(cal, sEvent, title, originId, updatedStr, sourceCalId)` | 186 | 対象カレンダーへのイベント作成ヘルパー |
| `checkHolidayOrWeekend(date)` | 213 | 休日・週末・職場独自休日の判定 |

### 通知関数

| 関数 | 行 | 役割 |
|------|-----|------|
| `sendNotifications()` | 267 | Discord/Google Chat への通知ディスパッチ |
| `sendDiscord(message)` | 289 | Discord Webhook送信 |
| `sendGoogleChat(message)` | 310 | Google Chat Webhook送信 |

### ユーティリティ関数

| 関数 | 行 | 役割 |
|------|-----|------|
| `recordLog(msg)` | 259 | コンソール出力 + 通知バッファへの記録 |
| `formatDate(date)` | 331 | `MM/dd HH:mm` 形式のフォーマット（Asia/Tokyo） |
| `setupProperties()` | 338 | Script Propertiesのデフォルト枠作成 |
| `testAccess()` | 371 | カレンダーアクセスのデバッグ確認 |

### 同期フロー

```
main()
  ├── loadConfig()
  ├── syncDirection(Work → Life)  // 休日・祝日の仕事予定を共有
  │     ├── Upsert: キーワードマッチ or 休日判定 → 作成/更新
  │     └── Delete: ソースに存在しない対象イベントを削除
  ├── syncDirection(Life → Work)  // 平日の私用を「休暇」としてマスク共有
  │     ├── Upsert: キーワードマッチ or 平日判定 → 作成/更新
  │     └── Delete: ソースに存在しない対象イベントを削除
  └── sendNotifications()         // 変更があればDiscord/Chat通知
```

### イベント追跡メカニズム

同期されたイベントは以下の**タグ**で追跡される（descriptionではなくタグを使用）:

- `origin_id` - 元イベントのID
- `origin_updated` - 元イベントの最終更新日時（ISO文字列）
- `source_calendar_id` - 同期元カレンダーのID

## 使用するGAS API

- **CalendarApp** - カレンダー操作（イベントCRUD、タグ管理）
- **PropertiesService** - スクリプトプロパティ（設定管理）
- **UrlFetchApp** - Webhook通知送信（Discord, Google Chat）
- **Utilities** - 日付フォーマット
- **日本の祝日カレンダー** - `ja.japanese#holiday@group.v.calendar.google.com`

## 設定プロパティ一覧

### 必須

| プロパティ | 説明 |
|-----------|------|
| `WORK_CALENDAR_ID` | 仕事カレンダーのID |
| `LIFE_CALENDAR_ID` | 私生活カレンダーのID |

### オプション（デフォルト値あり）

| プロパティ | デフォルト | 説明 |
|-----------|-----------|------|
| `SYNC_KEYWORDS_TO_LIFE` | `[Life],出張,深夜作業` | Work→Life同期キーワード |
| `SYNC_KEYWORDS_TO_WORK` | `[Work],通院,役所` | Life→Work同期キーワード |
| `MASK_TITLE_WORK` | `仕事` | Work→Lifeマスク時タイトル |
| `MASK_TITLE_LIFE` | `休暇` | Life→Workマスク時タイトル |
| `MASK_WORK_TO_LIFE` | `false` | Work→Lifeでタイトルをマスクするか |
| `SYNC_DAYS` | `30` | 同期対象期間（日数） |
| `WEEKEND_DAYS` | `0,6` | 週末曜日（0=日, 6=土） |
| `HOLIDAY_IGNORE_LIST` | `節分,バレンタイン,...` | 祝日判定除外リスト |
| `CUSTOM_HOLIDAY_KEYWORDS` | (空) | 職場独自休日キーワード |
| `DRY_RUN` | `false` | テストモード |
| `DISCORD_WEBHOOK_URL` | (空) | Discord Webhook URL |
| `GOOGLE_CHAT_WEBHOOK_URL` | (空) | Google Chat Webhook URL |

## デプロイ方法

1. Google Apps Scriptプロジェクトを作成
2. `Code.js` をGASエディタに貼り付け、または `clasp push` でデプロイ
3. スクリプトプロパティで `WORK_CALENDAR_ID` と `LIFE_CALENDAR_ID` を設定
4. `main` 関数を時間主導型トリガー（推奨: 1時間おき）で設定

初回は `DRY_RUN=true` で動作確認を推奨。

## テスト方法

自動テストフレームワークは未導入。手動テストのみ:

- **`DRY_RUN=true`** - 変更を適用せずにログで同期内容を確認
- **`testAccess()`** - カレンダーへのアクセス権限を確認
- **`setupProperties()`** - デフォルトのプロパティ枠を作成

## コーディング規約

### 命名規則

- **グローバル定数/設定:** `UPPER_SNAKE_CASE` (例: `CONFIG`, `WORK_CAL`, `LOG_BUFFER`)
- **関数:** `camelCase` (例: `syncDirection`, `checkHolidayOrWeekend`)
- **ローカル変数:** `camelCase` (例: `sourceId`, `targetCal`)
- **設定プロパティ:** `UPPER_SNAKE_CASE` (例: `WORK_CALENDAR_ID`)

### コードスタイル

- コメントは日本語で記述
- JSDoc形式の関数コメント
- Issue番号をインラインコメントで参照（例: `// Issue #8: 複数キーワードチェック`）
- `let` でグローバル変数を宣言（GAS V8ランタイム）

### ドキュメント

- README.md は日本語で記述
- コミットメッセージは日本語、接頭辞は英語（例: `feat:`, `fix:`, `docs:`, `refactor:`）

### 設計方針

- **プライバシーファースト:** マスク機能でイベント内容を隠蔽
- **双方向だが非対称:** Work→Lifeはタイトル表示可、Life→Workは常にマスク
- **タグベース追跡:** descriptionではなくタグでメタデータを管理（競合防止）
- **キーワード部分一致:** `String.includes()` による柔軟なマッチング
- **Upsertパターン:** 既存更新 → 新規作成 → 孤立削除 の順で処理

## 変更時の注意事項

- **Code.js は単一ファイル構成** - すべてのロジックが1ファイルに集約されている
- **GAS特有の制約** - `import`/`export` は使えない。グローバルスコープで関数を定義する
- **タグの互換性** - `origin_id`, `origin_updated`, `source_calendar_id` の3タグは同期の根幹。変更すると既存の同期済みイベントとの整合性が壊れる
- **祝日カレンダーID** - `ja.japanese#holiday@group.v.calendar.google.com` はハードコードされている（日本向け専用）
- **Webhook ペイロード形式** - Discord (`content`) と Google Chat (`text`) で異なるフィールド名を使用する
