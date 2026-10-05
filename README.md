# 📦 CF-Workers-GitHub
![img](./img.png)

基于 Cloudflare Workers / Pages 的 GitHub 镜像代理：加速 release、archive、raw 文件、Gist 与 `git clone`，并提供一个带 Bing 每日壁纸的首页。

> [!CAUTION]
> 上游演示域名 **Github.fxxk.dedyn.io 已被 GFW 污染**，生产环境请自行部署。

> [!WARNING]
> 伪装（`URL=nginx` / `URL302`）与壁纸首页**互斥**——设了伪装就永远轮不到首页。详见下方「处理优先级」。

## 🚀 使用

域名后面直接拼 GitHub 链接即可（协议头可省略，`http://` 会自动转成 `https://`）：

```
https://<你的域名>/https://github.com/<user>/<repo>/releases/download/<tag>/<file>.zip
```

**实际支持的路径**（超出下面这些会落到首页，不会被代理）：

| 用途 | 路径 |
|---|---|
| 分支 / release 压缩包 | `github.com/<u>/<r>/archive/<ref>.zip`、`.../releases/download/<tag>/<f>` |
| 仓库文件 | `github.com/<u>/<r>/blob/<ref>/<path>`（自动改写为 `/raw/`） |
| git clone | `github.com/<u>/<r>.git/info/refs?service=git-upload-pack`、`.../git-upload-pack` |
| raw 文件 | `raw.githubusercontent.com/<u>/<r>/<ref>/<path>` |
| Gist | `gist.githubusercontent.com/<u>/<id>/raw/<path>` |
| tags | `github.com/<u>/<r>/tags` |

访问私有仓库：

```
git clone https://user:TOKEN@<你的域名>/https://github.com/<u>/<r>.git
```

首页输入框粘贴链接后会**新开标签页**访问；也可手动用 `/?q=<GitHub链接>`（**该入口只在首页生效**）。

## 📦 部署

### 方式一：上传压缩包（最省事）

在**仓库根目录**打包 —— `_worker.js` 必须位于压缩包最外层，多包一层文件夹就不会被识别：

```bash
zip -r site.zip . -x '.git/*'
```

Workers & Pages → Create application → **Drag and drop your files** → 上传 zip → Deploy site。

> 拖拽限制：1000 个文件 / 单文件 25 MiB

### 方式二：连接到 Git

Workers & Pages → Create application → **Connect to Git** → 选中本仓库 → Build command 留空、Output directory 填 `/` → 部署。之后每次 push 自动更新。

### 方式三：Workers 编辑器

新建 Worker → 将 [`_worker.js`](./_worker.js) 全文粘贴进编辑器 → Deploy。

### 绑定自定义域

项目 → Domains & Policies → Set up a custom domain，按提示到域名 DNS 服务商添加一条指向 `<项目名>.pages.dev` 的 CNAME。

## 🔧 环境变量

项目 → **Settings → Environment variables**。运行时读取，一般**改完即可生效、无需重新部署**（若没变化稍等片刻或重新 Deploy 一次）。
注意 Production / Preview 是两套独立作用域，自定义域名走的是 **Production**。

| 变量 | 示例 | 默认 | 说明 |
|---|---|---|---|
| `URL` | `nginx` / `https://example.com/` | 空 | 主页伪装：`nginx` 返回内置伪装页；填其它地址则把首页反代过去 |
| `URL302` | `https://t.me/xxx` | 空 | 首页 302 跳转，**优先级高于 `URL`** |
| `UA` | `curl,wget,SomeBot` | 内置 `netcraft` | 追加的爬虫 UA 黑名单，命中返回伪装页（不区分大小写，空格/制表符/竖线/逗号/换行分隔） |
| `BG_INTERVAL` | `8000` | `12000` | 首页壁纸轮播间隔，单位毫秒，有效 `3000`~`600000`（越界自动收敛） |
| `BG_OPACITY` | `0.6` | `1` | 首页壁纸透明度，有效 `0`~`1`（非法值回落默认） |

### 处理优先级

```
UA 命中 → ?q= 301 → /favicon.ico → 代理匹配 → URL302 → URL → 壁纸首页
```

**要看到壁纸首页：`URL` 和 `URL302` 必须都为空。** 这是最常踩的坑——旧版文档建议用 `URL=nginx` 做伪装，一旦设上，首页分支就永远执行不到。

## 📌 实际行为说明

- **首页**：服务端拉取 Bing 每日壁纸（8 张），双图层交叉淡入 + 缓慢推近；接口失败时静默回退到深色渐变背景，不影响使用。结果服务端缓存 30 分钟，失败后 60 秒内不重试，单次回源 3 秒超时。
- **`/favicon.ico`** 由 Worker 内置返回（`Cache-Control: public, max-age=86400`）。
- **不会回传压缩包里的静态文件**：Worker 未接入 `env.ASSETS`，除上述代理路径和 favicon 外，其余路径全部落到首页分支。
- `PREFIX`、`Config.jsdelivr`、`whiteList` 是 `_worker.js` 顶部的**源码常量**，改完需重新部署；`PREFIX` 必须以 `/` 结尾。
  - `Config.jsdelivr = 1` → `blob` 链接 302 到 jsDelivr（默认 `0`，改为 `/raw/` 后代理）
  - `whiteList` 非空 → 路径必须包含其中某个片段，否则返回 403
- 跟随跨源重定向时会丢弃 `Authorization` / `Cookie`（避免凭据外泄），最多跟随 10 次重定向。

## 🧪 测试

```bash
node test/harness.mjs   # 42/42，零依赖
```

# 🙏 致谢
[gh-proxy](https://github.com/hunshcn/gh-proxy)、[jsproxy](https://github.com/EtherDream/jsproxy/)
