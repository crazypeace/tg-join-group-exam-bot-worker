# tg-join-group-exam-bot-worker
运行在cloudflare worker上的telegram加群验证机器人

基于 [python版](https://github.com/crazypeace/tg-join-group-exam-bot) 修改而来

# 说明
如果设置多个问题, 那么就需要保存`用户正在验证哪个问题`这个状态, 如果写入KV的话, 免费版1天只有1,000次写入.  
所以本项目简化为只有一个问题 "我的博客的最新一期博文标题是什么"

# 面向Agent开发
Hermes 对接 qwen3.8-flash
