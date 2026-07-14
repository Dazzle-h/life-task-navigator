# 人生任务提示器

这是一个可直接部署到 Vercel 的轻量 AI 任务澄清工具。

## Vercel 环境变量

- `OPENROUTER_API_KEY`：必填，只放在 Vercel，不要写进代码或提交到 GitHub。
- `OPENROUTER_MODEL`：选填，默认使用 `openrouter/auto`。

## 文件结构

```text
index.html       # 网页界面
api/analyze.js   # Vercel 后端函数，安全调用 OpenRouter
```

上传到 GitHub 后，Vercel 会自动重新部署。打开 Vercel 网址，登记一个新任务即可测试 AI 建议。

建议在 OpenRouter 为该 Key 设置较低的额度上限；当前版本还没有用户登录，后端仅做了基础请求频率限制。
