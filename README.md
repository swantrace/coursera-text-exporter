# Coursera Text Exporter

Manifest V3 Unpacked Chrome 扩展，通过 Coursera API 采集课程字幕与阅读文本。无需滚动课程页面，任务保存在 IndexedDB，关闭 Popup 后可继续处理，Worker 中断后由 alarm 恢复。

## 快速开始

```bash
npm ci
npm run build
```

1. 在 **准备加载扩展的同一个 Chrome 配置文件** 中登录 [Coursera](https://www.coursera.org/?authMode=login)。
2. 打开 `chrome://extensions`，开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本项目的 **`dist/`**。
4. 打开扩展，填写课程链接或 slug，选择语言并点击「开始采集」。
5. 完成后选择 ZIP、Markdown、TXT 或 JSON，点击「导出」。部分失败仍可导出，缺失原因在界面及 `report.json` 中。

本项目默认填写的验证课程：
https://www.coursera.org/learn/packt-scalable-node-js-advanced-patterns-integration/home/module/1

**代码或配置更新后运行 `npm run build`，再在扩展管理页点击刷新。** 首次加载后若「读取当前页面」失败，刷新课程标签页即可；手动输入课程链接不依赖 Content Script。

## 当前验证范围

- 真实匿名请求已验证指定课程的大纲与视频元数据结构。匿名大纲有 3 个模块和 52 个课时引用，但只提供第一节预览课的详情；因此完整采集需要登录及课程访问权限。
- `tests/fixtures/preview-*.json` 来源于上述公开响应；视频 fixture 已移除媒体链接和签名参数。
- 混合课程自动化测试使用合成响应，包含视频、阅读、锁定与不支持课时。
- 完整登录课程采集、真实 Google 授权/上传仍需使用用户浏览器与 Google Cloud 配置验证。未将模拟测试视为这两项验收通过。

## Google Drive 配置

本地导出不需要 Google OAuth。启用 Drive：

1. 在 Google Cloud 项目启用 Google Drive API，配置 OAuth 同意屏幕；测试模式添加自己的 Google 账号。
2. 运行一次 `npm run build`，记录终端输出的 Extension ID。
3. 创建 **Chrome Extension** 类型 OAuth 客户端，填写该扩展 ID。
4. 复制 `config.example.json` 为 `config.local.json`，填入：

```json
{
  "googleClientId": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "assetOrigins": []
}
```

5. 再次构建、刷新扩展，点击「连接 Google Drive」。之后可手动「同步全文」或勾选自动同步。

只申请 `drive.file`；在 Drive 中创建 `Coursera Text Exports` 文件夹，上传课程 Markdown 全文。相同账号、课程与采集选项对应同一文件；内容未变时跳过，改变时更新。首次创建使用预生成 ID，上传响应丢失后避免重复创建。大于 5 MiB 使用可恢复分块上传。TXT/JSON/ZIP 为本地导出格式。

`.local/extension-public-key.txt` 是固定扩展 ID 的公钥，**不要删除**。换电脑时连同该公钥复制过去可保持 ID 一致。没有私钥或 client secret 存入扩展；Google access token 由 Chrome Identity 管理，不写入本地数据库或日志。

OAuth 官方指南：https://developer.chrome.com/docs/extensions/how-to/integrate/oauth

## CDN 域名权限

默认只允许 `www.coursera.org` 和 `www.googleapis.com`。字幕代理通常是 Coursera 相对路径。若资源指向其他域名，界面会报告 `HOST_PERMISSION` 和所需 origin。将实际资源 HTTPS origin 加入 `config.local.json` 的 `assetOrigins` 数组，然后重新构建、刷新、重试。例如输入形如 `https://具体资源域名`，不填写路径、通配符或签名参数。

不会默认请求所有网站权限。远程资源不能请求任意 URL；Google 授权头只允许发送至 `www.googleapis.com`。

## 采集与恢复行为

- 大纲按 `moduleIds → lessonIds → itemIds` 顺序重建；缺少引用时明确报错，防止只下载预览课却显示整门课程成功。
- 字幕优先 `subtitlesVtt`。保留原始 VTT、解析后的文本与 SRT；语言缺失时回退至英语或第一个可用语言，并记录提示。
- 阅读支持内嵌 HTML、Markdown、纯文本和文本资源 URL，以及已适配的 CML 文本标签。未知 CML 元素报错；PDF、图片、外链资源记为不支持，不进行 OCR 或音频转录。
- HTML 通过 AST 转换，不在课程页面执行；保留常见标题、列表、表格、链接与代码。复杂公式、嵌入式交互或未适配富文本需要补充 fixtures 和适配器。
- 3 个并行任务、Coursera 请求间隔至少 500ms；429 支持 Retry-After，网络故障最多 4 次额外重试。
- Google 401 清除失效缓存 Token 后再获取一次；需要交互时仅阻塞同步。Coursera 登录过期暂停采集。
- 字幕每次下载前重新解析元数据；403 时再刷新一次签名。阅读资源 403 同样重新解析资源。
- 暂停/取消会中断在途请求，并使旧租约的迟到结果无法提交。取消不会删除已完成文本。
- 单个远程文本资源上限 25 MiB；所有大文本和队列保存在 IndexedDB。ZIP 目前在内存中打包，特别大的多语言课程可改用 Markdown/TXT 导出。
- 浏览器关闭或机器睡眠期间不运行；恢复后由任务 alarm 继续。不能保证 alarm 准时触发。
- 「删除所选本地记录」不删除下载文件或 Drive 文件。扩展卸载会移除本地采集记录。

## 开发与测试

```bash
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run smoke
```

`npm run check` 执行类型检查、单元/集成测试及生产构建。`npm run smoke` 在隔离的 Chromium 配置文件加载真实扩展，使用模拟 API 完成混合课程采集、Popup 重开和 Offscreen ZIP 生成。不会使用或修改用户浏览器登录信息。

测试覆盖：真实匿名响应结构、VTT/SRT 选择、字幕解析、阅读转换、请求边界、租约竞争/回收、取消后结果隔离、Google Token 更新、上传响应丢失时去重，以及大文件断点上传。

## 目录

- `src/background/`：Worker、持久化调度与本地下载。
- `src/api/`：Coursera API、限速与网络错误分类。
- `src/parsers/`：大纲、WebVTT、HTML/Markdown/CML。
- `src/storage/`：IndexedDB 事务、队列与快照。
- `src/sync/`：Google Identity、multipart 与 resumable upload。
- `src/export/`：课程聚合、报告与 ZIP。
- `src/popup/`：中文控制面板，Tailwind CSS 4 + daisyUI 5。
- `src/offscreen/`：本地 Blob URL 创建。
- `src/content/`：仅识别当前课程 URL。

## 常见问题

**MISSING_REFERENCE**：API 只返回部分课时。先确认同一 Chrome 已登录、已加入课程且能打开具体课时，然后点击「重试失败」。若仍存在，需要检查真实响应，不能单靠增加并发解决。

**SCHEMA_MISMATCH / CML_UNSUPPORTED**：课程采用了不同响应结构。保留错误文字以便扩展适配器，不要发送 Cookie、OAuth Token 或签名链接。

**HOST_PERMISSION / NETWORK**：检查网络及实际资源域名。服务端重定向到新域名时也可能需要新增权限。

**GOOGLE_CONFIG**：尚未填写 OAuth Client ID。无需修改此配置也能本地导出。

**GOOGLE_AUTH**：点击「连接 Google Drive」后再点击同步或重试失败。
