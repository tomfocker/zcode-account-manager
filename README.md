# ZCode Account Manager

ZCode 多账号管理与额度查看工具，基于 Electron 构建的桌面应用。

## 功能

- **Provider 切换** — 一键在 Z.ai 和 BigModel 之间切换，自动重启 ZCode 生效
- **多账号管理** — 自动记录登录过的账号，支持重命名、删除、一键切换
- **额度实时查看** — 每个账号独立显示各模型的 Token 用量进度条，红/橙/绿 三色告警
- **重置倒计时** — 显示额度周期剩余时间（多少小时后重置）
- **自动备份** — 切换账号前自动备份当前凭证，确保数据安全
- **凭证加密解密** — 读取 ZCode 原生 AES-256-GCM 加密凭证，无需额外密钥

## 截图

![screenshot](screenshot.png)

## 系统要求

- Windows 10+
- [Node.js](https://nodejs.org/) 18+
- [ZCode](https://zcode.z.ai) 客户端

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/tomfocker/zcode-account-manager.git
cd zcode-account-manager

# 安装依赖
npm install

# 启动
npm start
```

或直接双击 `start.bat`。

## 技术栈

| 模块 | 技术 |
|------|------|
| 桌面框架 | Electron 33 |
| 进程通信 | IPC Main/Renderer + contextBridge |
| 凭证解密 | AES-256-GCM (Node.js crypto) |
| 网络请求 | Node.js https module |
| UI 样式 | 纯 CSS (CSS Variables + Flexbox) |

## 数据存储

所有账号数据存储在 `~\.zcode\v2\account-snapshots\`：

```
account-snapshots/
├── accounts.json          # 账号索引
├── credentials/           # 每账号凭证快照
└── _auto-backup/          # 切换前自动备份
```

不修改 ZCode 原生的 `credentials.json` 加密逻辑，仅做备份与切换。

## License

MIT

