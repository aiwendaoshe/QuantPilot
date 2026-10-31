# 参与贡献 · QuantPilot

感谢你关注 **QuantPilot**！本项目欢迎 Issue 与 Pull Request。

## 开发环境

- **Node.js 20+**（推荐 20 LTS）
- **npm 10+**
- **Windows 10 / 11**（当前 CI 仅构建 Windows 安装包；macOS/Linux 暂未纳入打包矩阵）

## 本地运行

```bash
npm install
npm run dev        # 启动 Electron + Vite 开发模式
```

## 构建安装包

```bash
npm run dist:win   # 等价于 npm run build && electron-builder --win
```

产物位于 `release/QuantPilot-Setup-<version>.exe`。

## 代码规范

- TypeScript 使用 **strict** 模式，新增代码需通过：
  - `npm run typecheck`（node + web + worker 三套 tsconfig 全量校验）
- 提交信息建议遵循 [Conventional Commits](https://www.conventionalcommits.org/)：
  `feat:` / `fix:` / `docs:` / `refactor:` / `chore:` 等前缀。
- 不引入未声明的第三方依赖。`better-sqlite3` 为原生模块，请勿在渲染进程中直接 `require`。
- 改动 `strategy/`（Worker 编译）后，务必确认 `dist-electron/.../strategyWorker.js` 时间戳已更新，避免打包旧产物。

## 分支与合并

- `main` 为保护分支。请基于 `main` 开特性分支，PR 合并回 `main`。
- 合并前请确保 CI（**Build Windows**）通过。

## 数据诚实化原则（重要）

本项目对行情/财务数据有硬性诚实要求，贡献时务必遵守：

- 数据源不提供即留空 / 0 并**如实标注**，**禁止用 volume×close 等方式估算造假**。
- **禁止未来函数**：实时数据只进实时选股，不进历史回测。
- 任何「无源 / 代理值」字段必须在 UI 或文档中**显式标注**。

## 提 Issue / PR

- Bug 请使用 **Bug report** 模板，附版本号、操作系统、复现步骤。
- 新功能请使用 **Feature request** 模板。
- PR 请填好 PR 模板中的自检清单。

## 许可证

提交即视为你同意以仓库根目录 `LICENSE`（MIT）的条款发布你的贡献。
