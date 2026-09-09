/**
 * tg-join-group-exam-bot — Cloudflare Worker 版
 *
 * 设计（与 VPS 版的行为映射）:
 *  - webhook 推模式替代 getUpdates 长轮询
 *  - 完全无状态: 不存 pending_users, 不存 valid 白名单(放行 = Telegram 服务端的成员权限 override)
 *  - 题库: 按 user_id 快速哈希固定题型 (blog/rss/youtube 三选一, 与 tg-send-msg-exam-worker 同算法)
 *      blog    固定答案 zelikk.blogspot.com
 *      rss     判分瞬间实时抓 RSS 重算答案
 *      youtube 固定答案 youtube.com/@crazypeace
 *  - 私聊 /start 先查 getChatMember 权限: 已能发言(restricted+can_send_messages=true, 或 member/admin/creator) = 已放行, 不出题
 *     (放行态在 Telegram 眼里仍是 restricted —— DEFAULT_PERMISSIONS 里 can_send_other_messages/can_send_polls 为 false)
 *  - 群组默认权限保持"可发言"; 新成员(ID>=2B)入群禁言 -> 私聊验证 -> 通过后恢复发言
 *  - ID < 2,000,000,000 的早期用户免验证(与 VPS 版一致)
 *  - 非群成员抢先私聊: 只回功能简介, 不进验证流程(与 VPS 版一致)
 *  - 自动删消息功能: 按新方案砍掉
 *
 * 环境变量 (wrangler secret / vars):
 *  - BOT_TOKEN     : secret, 机器人 token
 *  - SECRET_TOKEN  : secret, webhook 校验用; 部署后 GET /registerWebhook 自注册
 *  - CHAT_ID       : vars, 目标群 ID (-100xxxxxxxxxx)
 *  - RSS_URL       : vars, 博客的RSS
 */

const TG_API = "https://api.telegram.org/bot";
const LEGACY_USER_ID_MAX = 2000000000; // ID 小于此值 = 早期用户, 免验证

const Q_TYPES = ["blog", "rss", "youtube"];

const BLOG_ANSWER = "zelikk.blogspot.com";
const YOUTUBE_ANSWER = "youtube.com/@crazypeace";

const QUESTION_TEXT = {
  blog: "❓ 请问：我的博客地址是什么？\n\n请直接输入答案",
  rss: "❓ 请问：我的博客的最新一期博文的标题是什么？\n\n请直接输入答案",
  youtube: "❓ 请问：我的Youtube频道url是什么？\n\n请直接输入答案",
};

const INTRO_TEXT =
  "👋 你好！我是群组验证机器人。\n\n" +
  "🔹 新成员加入群组时，我会暂时禁言他们\n" +
  "🔹 新成员需要向我发送 /start 并回答验证问题\n" +
  "🔹 验证通过后，我会自动解除禁言";

// 与 VPS 版 ChatPermissions 逐字段一致; 
const MUTE_PERMISSIONS = {
  can_send_messages: false,
  // can_send_audios: false,
  // can_send_documents: false,
  // can_send_photos: false,
  // can_send_videos: false,
  // can_send_video_notes: false,
  // can_send_voice_notes: false,
  // can_send_polls: false,
  // can_send_other_messages: false,
  // can_add_web_page_previews: false,
};

const DEFAULT_PERMISSIONS = {
  can_send_messages: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_audios: true,
  can_send_voice_notes: true,
  can_send_documents: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_send_polls: true,
};

// ---------------------------------------------------------------- 基础设施

async function api(env, method, payload) {
  const res = await fetch(`${TG_API}${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(
      `${method} failed: ${data.error_code} ${data.description}` +
        ` (chat=${payload.chat_id} user=${payload.user_id ?? ""})`
    );
  }
  return data.result;
}

// 机器人自身 username, isolate 内缓存一次
let _botUsername = null;
async function botUsername(env) {
  if (!_botUsername) {
    const me = await api(env, "getMe", {});
    _botUsername = me.username;
  }
  return _botUsername;
}

// Python user.mention_markdown() 的等价物 (改用 HTML parse_mode, 免去 MarkdownV2 转义)
function mention(user) {
  const name = (user.first_name || user.username || String(user.id)).replace(
    /[<>&]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])
  );
  return `<a href="tg://user?id=${user.id}">${name}</a>`;
}

// ---------------------------------------------------------------- 出题/判分

// 归一化: 统一小写、去掉全部空白 — 与 VPS 版 re.sub(r'\s+','',x.lower()) 一致
function normalize(s) {
  return String(s).toLowerCase().replace(/\s+/g, "");
}

// 非常快的 32-bit 混合 (Knuth 黄金比例乘法 + xorshift), 仅整数运算, 无字符串/BigInt
// 种子 = userid ^ 天数 (unix ms 整除 86400000 的纯数字) — 同一天内题型稳定, 跨天可能变化
function questionType(userId, now = Date.now()) {
  const seed = (userId | 0) ^ Math.floor(now / 86400000);
  let x = Math.imul(seed, 0x9e3779b1) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x21f0aaad) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0; // 末尾必须再转 unsigned, 否则可能为负 -> %3 得负索引
  return Q_TYPES[x % 3];
}

// 解析 RSS, 取第一个 <item><title>; 支持 CDATA。失败抛错。
function parseRssTitle(xml) {
  // 定位第一个 <item>, 再取其中的 <title>
  const itemStart = xml.search(/<item[\s>]/i);
  const scope = itemStart >= 0 ? xml.slice(itemStart) : xml;
  const m = scope.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) throw new Error("RSS: no item title found");
  let title = m[1].trim();
  const cdata = title.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) title = cdata[1].trim();
  if (!title) throw new Error("RSS: empty title");
  return title;
}

// 实时抓 RSS, 取第一个 item 标题。失败抛错。
async function fetchLatestPostTitle(env) {
  const url = env.RSS_URL;
  const res = await fetch(url, {
    headers: { "User-Agent": "tg-join-group-exam-bot/1.0" },
    cf: { cacheTtl: 60 }, // 60s 边缘缓存, 抗洪峰
  });
  if (!res.ok) throw new Error(`RSS fetch HTTP ${res.status}`);
  return parseRssTitle(await res.text());
}

// 取某题型当前正确答案: blog/youtube 固定常量; rss 实时抓 (失败抛错)
async function computeAnswer(env, type) {
  if (type === "blog") return BLOG_ANSWER;
  if (type === "youtube") return YOUTUBE_ANSWER;
  return await fetchLatestPostTitle(env);
}

// ---------------------------------------------------------------- 业务流程

// 单群模式: 所有"写操作"仅响应 CHAT_ID 配置的群。
// CHAT_ID 未配置或占位符未替换时视为未启用, 一律跳过, 防误伤其它群/陌生人。
function isTargetChat(env, chatId) {
  const want = String(env.CHAT_ID ?? "").trim();
  return want !== "" && !want.includes("REPLACE") && String(chatId) === want;
}

// 新成员入群: 禁言 + 群公告 (join 事件本身就是成员, 无需 getChatMember)
async function handleJoin(env, newMember, chat) {
  if (!isTargetChat(env, chat.id)) return;
  const user = newMember.user;
  if (user.is_bot) return;
  if (user.id < LEGACY_USER_ID_MAX) return; // 早期用户免验证

  await api(env, "restrictChatMember", {
    chat_id: chat.id,
    user_id: user.id,
    permissions: MUTE_PERMISSIONS,
    use_independent_chat_permissions: true,
  });

  const username = await botUsername(env);
  await api(env, "sendMessage", {
    chat_id: chat.id,
    text:
      `👤 新成员 ${mention(user)} 已加入\n` +
      `🔒 已暂时禁言\n` +
      `💬 请私聊机器人 <a href="https://t.me/${username}">@${username}</a> 并发送 /start 完成验证`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  // 还有一个方案是设置 telegram group welcome message, 这样不会对其它群友造成影响
  // https://zelikk.blogspot.com/2026/09/telegram-group-welcome-message.html
  
  log(`joined+muted user=${user.id} chat=${chat.id}`);
}

// 读取目标群成员信息; 失败(不在群/被踢等)返回 null
async function fetchMember(env, userId) {
  try {
    return await api(env, "getChatMember", { chat_id: env.CHAT_ID, user_id: userId });
  } catch {
    return null;
  }
}

// 是否算在群内: member/administrator/creator/restricted
// (restricted = 在群里但被禁言 —— 正是"待验证成员"的状态, 绝不能排除)
function memberInGroup(m) {
  return ["member", "administrator", "creator", "restricted"].includes(m.status);
}

// 已放行判定: 能发言 = 已验证 (服务端权限 override 就是验证结果)。
// member/admin/creator 无权限字段(undefined); restricted 才有 can_send_messages 布尔。
function memberCanSend(m) {
  return m.can_send_messages !== false;
}

// 私聊 /start
async function handleStart(env, user) {
  if (!isTargetChat(env, env.CHAT_ID)) {
    await api(env, "sendMessage", {
      chat_id: user.id,
      text: "⚠️ 机器人尚未完成配置(CHAT_ID 未设置), 请联系群管理员。",
    });
    return;
  }
  // 早期用户: 免验证, 只回简介
  if (user.id < LEGACY_USER_ID_MAX) {
    await api(env, "sendMessage", { chat_id: user.id, text: INTRO_TEXT });
    return;
  }
  const m = await fetchMember(env, user.id);
  if (!m || !memberInGroup(m)) {
    // 非成员抢先私聊: 只回简介, 不进验证流程
    await api(env, "sendMessage", { chat_id: user.id, text: INTRO_TEXT });
    return;
  }
  // 已放行判定: restricted 但 can_send_messages=true (验证通过后的状态), 或 member/admin/creator -> 不出题
  if (memberCanSend(m)) {
    await api(env, "sendMessage", {
      chat_id: user.id,
      text: "✅ 你已经通过验证，可以直接在群组中发言了。",
    });
    return;
  }
  // 待验证 (被禁言): 出题
  const type = questionType(user.id);
  await api(env, "sendMessage", { chat_id: user.id, text: QUESTION_TEXT[type] });
  log(`quiz served user=${user.id} type=${type}`);
}

// 私聊文本回答: 实时重算答案并比对
async function handleAnswer(env, user, text) {
  if (!isTargetChat(env, env.CHAT_ID)) return; // 未配置: 不判分不放行
  if (user.id < LEGACY_USER_ID_MAX) return; // 免验证用户不需要这套
  const m = await fetchMember(env, user.id);
  if (!m || !memberInGroup(m)) return; // 非成员: 忽略
  if (memberCanSend(m)) return; // 已能发言 = 已验证, 不判分不出题

  const type = questionType(user.id);
  let correct;
  try {
    correct = await computeAnswer(env, type);
  } catch (e) {
    // RSS 暂时抓不到: 不出题不判分, 让用户稍后重试
    await api(env, "sendMessage", {
      chat_id: user.id,
      text: `⚠️ 暂时无法获取题目，请稍后重发消息再试。\n(${String(e.message || e).slice(0, 120)})`,
    });
    return;
  }

  const ok = normalize(correct).length > 0 && normalize(text).includes(normalize(correct));

  if (!ok) {
    // 答案错误: 重发同一题面, 下一轮判分仍会实时重算 (旧答案即刻作废)
    await api(env, "sendMessage", {
      chat_id: user.id,
      text: `❌ 答案错误，请重试！\n\n${QUESTION_TEXT[type]}`,
    });
    log(`wrong answer user=${user.id}`);
    return;
  }

  // 通过: 恢复发言权限 (写入服务端 override, 此后不再需要任何白名单)
  await api(env, "restrictChatMember", {
    chat_id: env.CHAT_ID,
    user_id: user.id,
    permissions: DEFAULT_PERMISSIONS,
    use_independent_chat_permissions: true,
  });

  await api(env, "sendMessage", {
    chat_id: user.id,
    text: `✅ 验证成功！\n\n你现在可以在群组中发言了。`,
  });

  const username = await botUsername(env);
  await api(env, "sendMessage", {
    chat_id: env.CHAT_ID,
    text: `✅ ${mention(user)} 已通过验证`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  log(`verified user=${user.id} chat=${env.CHAT_ID}`);
}

// 管理员命令 /new_member_verify <user_id> (在群内发起): 复活/手动补验入口
async function handleAdminVerify(env, update, argUserId) {
  const chat = update.message.chat;
  const from = update.message.from;

  if (!isTargetChat(env, chat.id)) {
    await api(env, "sendMessage", {
      chat_id: chat.id,
      reply_to_message_id: update.message.message_id,
      text: "⚠️ 机器人尚未完成配置(CHAT_ID 未设置)。",
    });
    return;
  }
  const self = await api(env, "getChatMember", { chat_id: chat.id, user_id: from.id });
  if (!["administrator", "creator"].includes(self.status)) {
    await api(env, "sendMessage", {
      chat_id: chat.id,
      reply_to_message_id: update.message.message_id,
      text: "❌ 只有管理员可以使用此命令。",
    });
    return;
  }
  if (!argUserId || !/^\d+$/.test(argUserId)) {
    await api(env, "sendMessage", {
      chat_id: chat.id,
      reply_to_message_id: update.message.message_id,
      text: "用法：/new_member_verify <user_id>",
    });
    return;
  }

  let target;
  try {
    target = (await api(env, "getChatMember", { chat_id: chat.id, user_id: Number(argUserId) })).user;
  } catch (e) {
    await api(env, "sendMessage", {
      chat_id: chat.id,
      reply_to_message_id: update.message.message_id,
      text: `❌ 找不到该用户: ${String(e.message || e).slice(0, 120)}`,
    });
    return;
  }
  await handleJoin(env, { user: target }, chat);
}

// ---------------------------------------------------------------- 分发

async function dispatch(env, update) {
  // 1) 群成员变化 -> 新成员入群
  const cm = update.chat_member;
  if (cm) {
    if (
      cm.new_chat_member?.status === "member" &&
      ["left", "kicked"].includes(cm.old_chat_member?.status)
    ) {
      await handleJoin(env, cm.new_chat_member, cm.chat);
    }
    return;
  }

  const msg = update.message;
  if (!msg || msg.from?.is_bot) return;
  const user = msg.from;
  const text = (msg.text || "").trim();

  // 2) 群内管理员命令
  if (msg.chat?.type !== "private" && text.startsWith("/new_member_verify")) {
    const arg = text.split(/\s+/)[1];
    await handleAdminVerify(env, update, arg);
    return;
  }

  // 3) 私聊
  if (msg.chat?.type !== "private") return;

  if (text.startsWith("/start")) {
    await handleStart(env, user);
    return;
  }
  if (text) {
    await handleAnswer(env, user, text);
  }
}

// ---------------------------------------------------------------- webhook 自注册
//
// SECRET_TOKEN 是保存在 Worker 里的变量(wrangler secret put SECRET_TOKEN),
// 不经过 query 传输。管理路径:
//   GET https://<worker>/registerWebhook
//     -> setWebhook(url=<worker>/webhook, secret_token=env.SECRET_TOKEN,
//        allowed_updates=["message","chat_member"]); ?drop=1 附带清队列
//   GET https://<worker>/unRegisterWebhook
//     -> deleteWebhook(?drop=1 决定是否丢弃积压)
// 投递路径: POST /webhook, 以 X-Telegram-Bot-Api-Secret-Token 头比对 env.SECRET_TOKEN。

async function registerWebhook(request, env) {
  if (!env.SECRET_TOKEN) {
    return Response.json({ ok: false, description: "SECRET_TOKEN not configured" }, { status: 500 });
  }
  const url = new URL(request.url);
  const result = await api(env, "setWebhook", {
    url: `${url.protocol}//${url.host}/webhook`,
    secret_token: env.SECRET_TOKEN,
    allowed_updates: ["message", "chat_member"],
    drop_pending_updates: url.searchParams.get("drop") === "1",
  });
  return Response.json({ ok: true, webhook_url: `${url.protocol}//${url.host}/webhook`, result });
}

async function unRegisterWebhook(request, env) {
  const url = new URL(request.url);
  const result = await api(env, "deleteWebhook", {
    drop_pending_updates: url.searchParams.get("drop") === "1",
  });
  return Response.json({ ok: true, result, webhook_info_url: (await api(env, "getWebhookInfo", {})).url || null });
}

// ---------------------------------------------------------------- 入口

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 管理路径: 注册/注销 webhook (用 env.SECRET_TOKEN, 不回显)
    if (url.pathname === "/registerWebhook") return registerWebhook(request, env);
    if (url.pathname === "/unRegisterWebhook") return unRegisterWebhook(request, env);

    // 更新投递: 只认 POST /webhook
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("not found", { status: 404 });
    }
    // secret 未配置时宁可拒绝所有投递, 也不裸奔
    if (!env.SECRET_TOKEN ||
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.SECRET_TOKEN) {
      return new Response("forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }

    // 业务处理放后台, 立即回 200 (Telegram 对非 2xx/超时 会重投)
    ctx.waitUntil(
      dispatch(env, update).catch((e) => log(`dispatch error: ${String(e.stack || e)}`))
    );
    return new Response("ok");
  },
};

// Workers 无 console 落盘, 用 logfn 占位; 部署后在 tail 里看
function log(line) {
  console.log(new Date().toISOString(), line);
}

// 导出纯函数仅供本地测试 (test.js); Worker 部署不受影响
export { dispatch, questionType, normalize, parseRssTitle };
