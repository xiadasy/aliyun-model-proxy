# 阿里云 DashScope 模型池反代

基于 Node.js 的零依赖反向代理服务，聚合阿里云 DashScope 多个免费模型，额度用完自动切换。

## 一键部署到 Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

点击上方按钮，用 GitHub 登录后：
1. **DASHSCOPE_API_KEYS** 填入你的阿里云 DashScope API Key
2. **PROXY_API_KEY** 会自动生成，也可以自己改
3. 点 Deploy，等 2-3 分钟即可

## 功能

- 对外统一暴露一个 API Key
- 支持 OpenAI 协议 (`/v1/chat/completions`) 和 Anthropic 协议 (`/v1/messages`)
- 免费额度耗尽自动切换下一个模型，客户端无感知
- 18+ 个免费模型，至少 1.8 亿免费 tokens
- 零依赖，纯 Node.js，无需 npm install

## 使用

```bash
node proxy.mjs
```

### OpenAI 兼容
```bash
curl http://localhost:3300/v1/chat/completions \
  -H "Authorization: Bearer YOUR_PROXY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"any","messages":[{"role":"user","content":"你好"}]}'
```

### Anthropic 兼容
```bash
curl http://localhost:3300/v1/messages \
  -H "Authorization: Bearer YOUR_PROXY_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"any","max_tokens":256,"messages":[{"role":"user","content":"你好"}]}'
```
