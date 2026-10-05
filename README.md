# 取件码展示（Pickup Code Display）

> 一款面向飞牛 fnOS 的快递取件码管理系统，支持**手动录入**与 **AI 拍照识别**，提供实时大屏展示、分组视图与状态管理，适用于驿站、代收点等场景。

- 应用标识：`pickup.codes`
- 当前版本：`1.2.2`
- 开源仓库：[YUNXI-fi/Pickup-Code-Display](https://github.com/YUNXI-fi/Pickup-Code-Display)
- 维护者：YUNXI

---

## 目录

- [核心功能](#核心功能)
- [技术栈与架构](#技术栈与架构)
- [环境要求](#环境要求)
- [安装步骤](#安装步骤)
- [配置说明](#配置说明)
- [使用指南](#使用指南)
- [API 一览](#api-一览)
- [项目目录结构](#项目目录结构)
- [贡献规范](#贡献规范)
- [许可证](#许可证)
- [联系方式](#联系方式)

---

## 核心功能

### 📦 取件码管理

- **手动录入**：填写取件码、快递公司、收件人、手机尾号、取件地址，一键添加
- **AI 识别录入**：上传快递面单照片，自动识别取件码、快递公司与取件地址（基于 SiliconFlow 视觉大模型）
- **历史自动补全**：录入收件人 / 手机尾号 / 取件地址时，自动联想历史记录，减少重复输入
- **状态管理**：待取件 / 已取件 / 已恢复（误点取件可恢复为待取件）
- **数据持久化**：数据存储在本地 SQLite 数据库，随应用持久保存

### 🖥️ 实时大屏展示

- **实时同步**：基于 SSE（Server-Sent Events）推送，新增 / 取件 / 删除即时刷新，多端同步
- **分组视图**：按「取件地址」或「取件情况」分组浏览
- **快速筛选**：全部 / 待取件 / 已取件一键切换
- **隐私保护**：展示页对收件人姓名、手机号自动脱敏
- **今日标记**：自动识别并标注当天新增的包裹

### 🔒 安全与权限

- **管理后台密码保护**：可设置管理员密码，展示页免密访问，管理操作需鉴权
- **会话保持**：登录会话时长可配置（默认 12 小时）

### 🛠️ 飞牛 fnOS 深度集成

- 支持应用商店安装向导（端口、密码、AI 配置可视化填写）
- 随系统开机自启、异常状态检测（start / stop / status 生命周期脚本）
- 通过 fnOS 网关反向代理访问，支持应用图标与桌面入口

---

## 技术栈与架构

### 技术栈

| 层级 | 技术选型 | 说明 |
| --- | --- | --- |
| 运行时 | Node.js ≥ 18 | 后端服务运行环境 |
| 后端框架 | Express 5 | REST API 服务 |
| 数据库 | sql.js（SQLite WASM） | 零依赖嵌入式数据库，单文件持久化 |
| 实时通信 | SSE | 服务端事件推送，实时刷新展示页 |
| 前端 | 原生 HTML + JavaScript | 无需构建，开箱即用 |
| 样式 | Tailwind CSS（CDN） | 响应式界面 |
| AI 识别 | SiliconFlow 视觉大模型 API | 快递面单 OCR 结构化识别 |
| 平台 | 飞牛 fnOS | manifest + 生命周期脚本打包为系统应用 |

### 架构概览

```text
┌──────────────────────────────────────────────┐
│                 浏览器端                      │
│   展示页 (/)  ←─SSE 实时推送──┐               │
│   管理页 (/admin.html) ──REST API──┤          │
└──────────────────────────────────────────────┘
                      │
                 Express 服务
              (app/server/server.js)
                      │
        ┌─────────────┼─────────────┐
        │             │             │
   REST API      SSE 推送      AI 识别转发
  (routes/packages)  (events)   (SiliconFlow)
        │
   sql.js 数据库 (data.db)
```

- 服务端采用**无状态单进程**架构，所有数据经由 `db.js` 统一访问 SQLite
- 数据变更通过 `broadcast()` 向所有 SSE 客户端广播，实现多端实时同步
- 支持 fnOS 网关前缀（`/app/pickup-codes`）自动剥离，同一代码可本地直跑或作为系统应用运行

---

## 环境要求

### 作为 fnOS 应用

- 飞牛 fnOS 系统（x86_64 / arm64 均可）
- 已安装并运行 **nodejs_v22** 依赖应用（安装时自动检查）

### 独立运行（本地 / 普通服务器）

| 依赖 | 版本要求 |
| --- | --- |
| Node.js | ≥ 18.0.0 |
| npm | 随 Node.js 附带 |
| 网络 | 如需 AI 识别功能，需可访问 `api.siliconflow.cn` |

> 无需额外数据库服务，数据存储于本地文件 `data.db`。

---

## 安装步骤

### 方式一：fnOS 应用安装（推荐）

1. 在 [Releases](https://github.com/YUNXI-fi/Pickup-Code-Display/releases) 下载 `pickup.codes_x.x.x_all.fpk` 安装包
2. 打开 fnOS 桌面 → **应用中心** → **手动安装**，选择该 `.fpk` 文件
3. 按向导填写：
   - **管理密码**（留空则不启用）
   - **会话保持时长**（默认 12 小时）
   - **SiliconFlow API Key** 与 **AI 模型**（可选，用于面单识别）
4. 安装完成后，在桌面点击「取件码展示」图标即可访问（经 fnOS 统一网关访问，不对外暴露端口）

### 方式二：独立运行（开发 / 调试）

```bash
# 1. 进入服务目录
cd app/server

# 2. 安装依赖
npm install

# 3. 复制环境变量模板并修改
cp .env.example .env

# 4. 启动服务
npm start        # 生产运行
npm run dev      # 开发模式（文件变更自动重启）
```

启动后：

- 展示页：<http://localhost:3000>
- 管理页：<http://localhost:3000/admin.html>
- 局域网访问：`http://<本机IP>:3000`

---

## 配置说明

通过环境变量或 fnOS 安装向导配置，所有配置项见 `.env.example`：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `ADMIN_PASSWORD` | 空 | 管理密码，留空则不启用鉴权 |
| `SESSION_DURATION_HOURS` | `12` | 登录会话保持时长（小时，1–720） |
| `SILICONFLOW_API_KEY` | 空 | SiliconFlow API Key（AI 面单识别） |
| `SILICONFLOW_MODEL` | `Qwen/Qwen3.6-27B` | AI 识别使用的视觉模型 |

配置示例：

```bash
PORT=3000
ADMIN_PASSWORD=my-secret
SILICONFLOW_API_KEY=sk-xxxxxxxxxxxxxxxx
```

> 获取 SiliconFlow API Key：前往 <https://cloud.siliconflow.cn> 注册并创建密钥。

---

## 使用指南

### 1. 展示页（大屏）

打开应用首页，即可看到所有待取件包裹：

- **切换分组**：「取件地址」按驿站/代收点归类展示；「取件情况」按待取/已取区分
- **筛选**：全部 / 待取件 / 已取件
- **标记取件**：点击包裹卡片上的「取件」按钮，状态即时更新并同步到所有屏幕

### 2. 管理页（后台）

访问 `admin.html`，首次访问需输入管理密码（若已启用）。

**手动添加快递：**

1. 填写取件码（必填）、快递公司、收件人、手机尾号、取件地址
2. 收件人 / 手机尾号 / 地址输入时自动弹出历史联想，可点击补全
3. 点击「添加」，新包裹将实时出现在展示页

**AI 识别添加：**

1. 点击表单下方的图片上传按钮，选择快递面单照片（支持多张）
2. 系统自动压缩并调用视觉模型识别，识别结果以标签形式展示
3. 逐个确认标签，点击「使用」填充到表单，或一键批量添加

**管理操作：**

- 点击包裹上的「已取件 / 恢复」切换状态
- 点击「删除」弹出确认框，确认后删除
- 顶部筛选按钮可切换 全部 / 待取件 / 已取件 列表

### 3. 操作示例

添加一个包裹并取件的完整流程：

```text
管理页填表 → 取件码: 6-2-3456，快递公司: 圆通，收件人: 张三，
手机尾号: 1234，取件地址: 菜鸟驿站(幸福小区店)
      ↓
点击「添加」
      ↓
展示页实时出现该包裹（按取件地址自动分组到「菜鸟驿站」）
      ↓
用户取件 → 展示页点击「取件」
      ↓
状态变为「已取件」，所有终端同步刷新
```

---

## API 一览

所有接口均挂载在 `/api` 下，管理类接口需携带 `x-admin-password` 请求头（或使用 `?pw=` 查询参数）。

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/packages` | 否 | 获取包裹列表（`?status=all` 返回全部，默认仅待取件） |
| POST | `/api/packages` | 是 | 新增包裹 |
| PATCH | `/api/packages/:id/pickup` | 否 | 标记已取件 |
| PATCH | `/api/packages/:id/restore` | 是 | 恢复为待取件 |
| DELETE | `/api/packages/:id` | 是 | 删除包裹 |
| GET | `/api/events` | 否 | SSE 实时事件流（create / update / delete） |
| POST | `/api/recognize` | 是 | AI 识别面单图片（base64） |
| GET | `/api/history?field=` | 否 | 历史联想（`recipient` / `phone` / `address`） |
| GET | `/api/check-password` | 否 | 校验管理密码 |

---

## 项目目录结构

```text
取件码展示/
├── app/
│   ├── server/                # 后端服务（独立可运行）
│   │   ├── server.js          # Express 入口、鉴权、静态资源、网关前缀
│   │   ├── db.js              # sql.js 数据库封装（初始化 / 增删改查）
│   │   ├── routes/
│   │   │   └── packages.js    # REST API + SSE 广播 + AI 识别转发
│   │   ├── public/            # 前端页面
│   │   │   ├── index.html     # 展示页（大屏）
│   │   │   ├── admin.html     # 管理页
│   │   │   ├── css/tailwind.css
│   │   │   └── js/
│   │   │       ├── app.js     # 展示页逻辑（分组、筛选、SSE、取件）
│   │   │       └── admin.js   # 管理页逻辑（表单、联想、AI 识别、增删改）
│   │   ├── .env.example       # 环境变量模板
│   │   └── package.json
│   └── ui/                    # fnOS 桌面入口配置与图标
│       ├── config             # 应用入口 / 网关映射
│       └── images/            # 应用图标（64 / 256）
├── cmd/                       # 生命周期脚本
│   ├── main                   # start / stop / status
│   └── *_callback / *_init    # 安装、升级、卸载回调
├── config/
│   ├── privilege              # 运行用户与权限
│   └── resource
├── wizard/                    # 安装向导表单（端口、密码、AI 配置）
├── manifest                   # fnOS 应用清单（元数据、依赖、端口）
├── ICON.PNG / ICON_256.PNG    # 应用图标
├── LICENSE                    # 许可协议
└── README.md
```

---

## 贡献规范

欢迎提交 Issue 与 Pull Request，参与贡献前请阅读以下规范：

1. **提交流程**
   - 先开 Issue 描述问题或需求，确认后再开发，避免无效 PR
   - Fork 仓库 → 新建功能分支 → 提交变更 → 发起 Pull Request
2. **代码规范**
   - 保持现有代码风格（无分号风格、2 空格缩进、单引号）
   - 不引入不必要的第三方依赖，优先使用 Node.js 原生能力
   - 提交信息使用简洁的英文描述，如 `feat: support batch import`
3. **测试要求**
   - 变更涉及 API 时，附上调用示例或自测结果
   - 确保 `npm start` 可正常启动，`data.db` 不影响首次运行
4. **文档同步**
   - 功能变更需同步更新 README 中对应章节

---

## 许可证

本项目基于**自定义非商用许可协议**发布，详见 [LICENSE](LICENSE)。核心条款：

- ✅ 允许个人学习、研究、非商业用途的使用、复制与修改
- ✅ 允许自由分发与转载
- ❌ **禁止**任何形式的商业盈利、付费售卖、商业服务与企业商用
- ❌ 分发或修改后的版本必须完整保留版权声明与许可协议
- ⚠️ 软件按「现状」提供，作者不对使用造成的损失承担任何责任

---

## 联系方式

| 项目 | 信息 |
| --- | --- |
| 维护者 | YUNXI |
| 开源仓库 | <https://github.com/YUNXI-fi/Pickup-Code-Display> |
| 维护者主页 | <https://www.myunxi.top> |
| 问题反馈 | 请在 GitHub Issues 提交 [Bug 报告 / 功能建议](https://github.com/YUNXI-fi/Pickup-Code-Display/issues) |
