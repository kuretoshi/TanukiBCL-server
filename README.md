# TanukiBCL Server

[![GPL-3.0 License][license-shield]][license-url]

TanukiBCL Server は、Among Us 向け近接ボイスチャットクライアント **TanukiBCL** / BetterCrewLink 互換クライアント用のシグナリングサーバーです。

このリポジトリは [OhMyGuus/BetterCrewLink-server](https://github.com/OhMyGuus/BetterCrewLink-server) をベースにしたフォークです。元プロジェクトの互換性を保ちながら、TanukiBCL 向けに通信安定性、Socket.IO 互換性、運用設定を調整しています。

## 概要

このサーバーは音声データそのものを常に中継するサーバーではありません。主な役割は以下です。

- ロビー参加者の管理
- WebRTC 接続に必要な `signal` の中継
- `clientPeerConfig` による STUN/TURN 設定の配信
- パブリックロビー一覧の配信
- P2P 接続が難しい環境向けの TURN フォールバック支援

通常の音声通信は WebRTC の P2P 接続で行われます。NAT やファイアウォールの都合で P2P 接続できない場合は、TURN サーバーを経由します。

## 主な変更点

- Socket.IO 4 へ更新
- `allowEIO3: true` により既存の `socket.io-client@2.4.x` クライアントにも対応
- WebRTC `signal` のロビー外転送を拒否
- `signal` / `VAD` / ロビー更新イベントの簡易レート制限
- ロビー人数上限の設定
- `peerConfig.yml` の部分設定に対するデフォルト補完
- 外部 TURN / coturn を使いやすい設定例を追加

## Socket.IO 互換性

このサーバーは Socket.IO 4 で動作します。

ただし Engine.IO 3 互換を有効にしているため、既存 BetterCrewLink 系クライアントで使われている `socket.io-client@2.4.x` からも接続できます。Socket.IO 4 クライアントからの接続にも対応します。

これにより、TanukiBCL クライアントは以下の両方へ接続できます。

- 既存の BetterCrewLink-server 系 Socket.IO 2.4.1 サーバー
- TanukiBCL Server の Socket.IO 4 サーバー

## 必要環境

- Node.js
- Yarn

```sh
corepack enable
yarn install
```

## 起動方法

```sh
yarn start
```

開発中にコンパイルだけ確認する場合:

```sh
yarn compile
```

デフォルトでは `9736` 番ポートで起動します。`HTTPS=true` の場合はデフォルトが `443` になります。

## クライアント設定

TanukiBCL / BetterCrewLink のサーバー URL 設定に、このサーバーの URL を指定してください。

例:

```txt
http://127.0.0.1:9736
https://voice.example.com
```

同じ Among Us ロビーにいる参加者は、基本的に同じボイスサーバー URL を使う必要があります。

## 環境変数

| 変数 | 説明 | デフォルト |
| --- | --- | --- |
| `PORT` | HTTP/HTTPS サーバーの待受ポート | `9736`、`HTTPS=true` 時は `443` |
| `HOSTNAME` | TURN サーバー用のホスト名または IP | なし |
| `NAME` | サーバー名 | なし |
| `HTTPS` | HTTPS を有効化する。`privkey.pem` と `fullchain.pem` が必要 | 無効 |
| `SSLPATH` | SSL 証明書の配置ディレクトリ | カレントディレクトリ |
| `MAX_LOBBY_CLIENTS` | 1ロビーあたりの最大接続数 | `20` |
| `RATE_LIMIT_WINDOW_MS` | レート制限の計測時間 | `10000` |
| `MAX_SIGNAL_EVENTS_PER_WINDOW` | 1 socket あたりの WebRTC signal 最大数 | `300` |
| `MAX_VAD_EVENTS_PER_WINDOW` | 1 socket あたりの VAD 最大数 | `60` |
| `MAX_LOBBY_EVENTS_PER_WINDOW` | 1 socket あたりのロビー更新系イベント最大数 | `20` |

## STUN / TURN 設定

WebRTC の接続方式は `config/peerConfig.yml` で設定できます。

初期状態では `config/peerConfig.example.yml` が用意されています。利用する場合はコピーして `peerConfig.yml` を作成してください。

```sh
copy config\peerConfig.example.yml config\peerConfig.yml
```

Linux / macOS の場合:

```sh
cp config/peerConfig.example.yml config/peerConfig.yml
```

### 内蔵 TURN サーバー

小規模な検証用途では、内蔵 TURN サーバーを有効化できます。

```yml
integratedRelay:
  enabled: true
  listeningPort: 3478
  minPort: 49152
  maxPort: 65535
```

内蔵 TURN を使う場合は `HOSTNAME` を設定してください。Cloudflare などのプロキシを通すホスト名ではなく、サーバーへ直接到達できる DNS 名または IP が必要です。

### 本番運用

本番運用では、内蔵 TURN よりも [coturn](https://github.com/coturn/coturn) などの外部 TURN サーバーを推奨します。

例:

```yml
iceServers:
  - urls: 'stun:stun.l.google.com:19302'
  - urls: 'turn:turn.example.com:3478?transport=udp'
    username: 'TurnUsername'
    credential: 'TurnPassword'
  - urls: 'turns:turn.example.com:443?transport=tcp'
    username: 'TurnUsername'
    credential: 'TurnPassword'
```

UDP が使える環境では `turn:3478?transport=udp` が低遅延です。学校、会社、ホテル Wi-Fi など UDP が制限される環境向けに `turns:443?transport=tcp` も用意しておくと接続成功率が上がります。

## API

### `GET /health`

サーバー状態を JSON で返します。

```json
{
  "uptime": 123,
  "connectionCount": 1,
  "lobbiesCount": 1,
  "address": "http://localhost",
  "name": "TanukiBCL"
}
```

### `GET /lobbies`

公開ロビー一覧を JSON で返します。

## Docker

Dockerfile は含まれていますが、イメージ名や公開先は運用環境に合わせて変更してください。

ビルド例:

```sh
docker build -t tanukibcl-server:local .
```

起動例:

```sh
docker run -d -p 9736:9736 --name tanukibcl-server tanukibcl-server:local
```

## ライセンス

このプロジェクトは GPL-3.0-or-later で配布されています。詳細は [LICENSE](LICENSE) を確認してください。

## 謝辞

このサーバーは [OhMyGuus/BetterCrewLink-server](https://github.com/OhMyGuus/BetterCrewLink-server) をベースにしています。BetterCrewLink / CrewLink コミュニティと元プロジェクトの貢献者に感謝します。

[license-shield]: https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg
[license-url]: LICENSE
