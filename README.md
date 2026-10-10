# 百合小说分享站 · 动态版

带后端的文件分享站：登录后可网页上传，游客可浏览 / 搜索 / 下载。

## 本地运行
```bash
npm install
PORT=3000 ADMIN_KEY=你的密钥 node server.js
```

## 环境变量
| 变量 | 说明 |
|---|---|
| `PORT` | 端口(默认 3000) |
| `HOST` | 监听地址(默认 0.0.0.0) |
| `ADMIN_KEY` | 作者区密钥 |
| `STORAGE_BACKEND` | `local` 或 `s3` |
| `S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_FORCE_PATH_STYLE` | S3 兼容存储(如 Cloudflare R2 / Backblaze B2) |

## 部署
支持 Node 的容器平台均可（Zeabur / Render / Railway 等）。
