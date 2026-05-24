# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [1.0.0] - 2026-05-24

### Added
- 平日の勤務時間外（始業前・終業後）のWORKイベントをLIFEに自動同期する機能 (#14)
- `WORK_START_HOUR` / `WORK_END_HOUR` スクリプトプロパティ（デフォルト: 10〜18時）
- `loadConfig()` での `WORK_START_HOUR` / `WORK_END_HOUR` 入力値検証

### Docs
- CLAUDE.md を追加（AIアシスタント向けコードベースガイド） (#12, #13)

## [0.999] - 2026-01-11

### Added
- 複数キーワードによる同期トリガー対応（カンマ区切り） (#8)
- Work→Life 方向のタイトルマスク機能 `MASK_WORK_TO_LIFE` / `MASK_TITLE_WORK` (#9)

### Changed
- カレンダー名を `HOME` から `LIFE` に変更（設定プロパティ: `HOME_CALENDAR_ID` → `LIFE_CALENDAR_ID`） (#7)

## [0.99] - 2026-01-10

### Added
- Google Chat Webhook 通知対応 (#3)
- `DRY_RUN` モード（変更を適用せずに動作確認） (#3)
- 職場独自の休日キーワード `CUSTOM_HOLIDAY_KEYWORDS` (#2)

### Fixed
- 「節分」「バレンタイン」など法定休日でないイベントを祝日判定から除外 (#1)

## [0.9] - 2026-01-09

### Added
- 初回リリース
- Work ↔ Life 双方向カレンダー同期（Upsertパターン）
- 休日・週末の自動同期
- キーワードによる手動同期トリガー
- イベントタグ（`origin_id`, `origin_updated`, `source_calendar_id`）による追跡
- Discord Webhook 通知
- `setupProperties()` / `testAccess()` ユーティリティ関数
