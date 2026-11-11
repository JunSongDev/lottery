# Cloudflare Workers 版开奖代理

给「页面一打开就自动核对最新开奖」用的远端代理。GitHub Pages 只发静态文件、
没有 `/api`，福彩官网又不返回 CORS 头（浏览器直连必被拦），所以取数这一步要
放到一个服务端上 —— Cloudflare Workers 免费版就够：**每天 10 万次请求、
不需要绑卡、不用备案**。代理逻辑见同目录 `worker.js`（行为与
`scripts/proxy_wsgi.py` 阿里云 FC 版完全一致）。

## 部署步骤（全程浏览器操作，约 5 分钟）

1. **注册 / 登录** [dash.cloudflare.com](https://dash.cloudflare.com)
   （免费版只要邮箱，不需要绑卡）。
2. 左侧菜单 → **Workers & Pages** → **Create** → 选 **Start with Hello World!**
   （模板名带 "Hello World" 即可）。
3. **Worker 名字**填 `lottery-proxy`（也可自定义）。
   第一次创建会先让你选一个 **workers.dev 子域名**（随意起个名字，比如
   `junsong`），点 **Deploy** 部署默认代码。
4. 部署完点 **Edit code**：把编辑器里的模板代码**全选删除**，把
   `worker.js` 的内容**整份粘贴**进去 → 右上角 **Deploy** → Confirm。

   > ★ 常见报错：粘贴后提示 `File system provider for cfs:/... is not available`
   > —— 这是 Cloudflare 在线编辑器在 **Safari** 下的兼容问题（浏览器内
   > 虚拟文件系统初始化失败），与代码无关。**换 Chrome 或 Edge** 打开
   > dash.cloudflare.com 重做第 4 步即可；粘贴时贴进编辑器默认打开的那个
   > 文件（不要自己新建文件）。还不行就走下面的「方案 B：命令行部署」。

5. 回到 Worker 概览页，顶部能看到你的地址，形如
   `https://lottery-proxy.<你的子域>.workers.dev`。

### 方案 B：命令行部署（编辑器打不开时用）

在项目目录的 `cloudflare/` 下执行（需要 Node.js，没有就
`brew install node`；首次会问登录，浏览器里点 Allow）：

```bash
cd cloudflare
npx wrangler login      # 只需一次；会自动打开浏览器授权
npx wrangler deploy     # 按 wrangler.toml 把 worker.js 部署上去
```

部署完同样输出 `https://lottery-proxy.<你的子域>.workers.dev` 的地址。

## 自检（重要，必须实测）

用**手机浏览器**（与你访问页面的同一网络环境）直接打开：

```
https://lottery-proxy.<你的子域>.workers.dev/ssq
```

应返回一段 JSON：`{"ok":true,...,"rows":[…30 条开奖…],"src":"中国福利彩票官网"}`。
再开 `/dlt` 同样核对一遍。

> ★ **如果不通**：大陆网络对 `workers.dev` 域名的可达性历史上不稳定
> （DNS 污染 / SNI 干扰），这是 Cloudflare 方案在大陆的主要变数。
> 自检打不开时按下面「如果不通」处理，不要直接写进 index.html。

## 自检通过后接入

把地址交给 Claude（改 `index.html` 里被注释的 `LIVE_PROXY` 并推送），
或者自己动手：把 `index.html` 里这行注释打开、填上你的地址——

```html
<script>window.LIVE_PROXY = 'https://lottery-proxy.<你的子域>.workers.dev';</script>
```

不想重新部署就先验收：在页面网址后加参数
`index.html?proxy=https%3A%2F%2Flottery-proxy.<你的子域>.workers.dev`
（`?proxy=` 是 URL 编码后的地址），刷新后顶部提示条应显示「新增 N 期 /
已是最新（…远端代理）」。

## 如果不通

按优先级：

1. **绑定自有域名**（最可靠）：在 Cloudflare 加一个你自己的域名
   （年费约 $10 的 `.com` / `.xyz` 都行），Worker → Settings →
   Domains & Routes 绑上去，走自己的域名就没有 workers.dev 的污染问题。
2. **维持现状（零成本，已够用）**：不开实时核对。数据由
   `.github/workflows/update-data.yml` 每个开奖日 21:45 / 22:45 自动抓取
   提交，Pages 上的数据最多旧一天；提示条只是温和提示、15 秒自动收起。
3. **回到国内云函数**：重新部署 `scripts/proxy_wsgi.py`（阿里云 FC /
   腾讯云 SCF，免费额度足够，大陆可达性最好）——即被替换前的原方案。

## 成本与限额

| 项 | 免费版额度 | 本项目用量 |
| --- | --- | --- |
| 请求数 | 100,000 次/天 | 每次打开页面 2 次（/ssq + /dlt），另有 2 分钟边缘缓存兜底 |
| CPU 时间 | 10 ms/次 | 解析 30 期 JSON，远低于限额 |
| 付费 | 不需要绑卡 | — |
