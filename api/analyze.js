const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 6;

globalThis.__lifeNavigatorRateLimits ||= new Map();

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return String(Array.isArray(forwarded) ? forwarded[0] : forwarded || req.socket?.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
}

function isRateLimited(req) {
  const now = Date.now();
  const ip = getClientIp(req);
  const recent = (globalThis.__lifeNavigatorRateLimits.get(ip) || []).filter(
    (timestamp) => now - timestamp < WINDOW_MS,
  );

  if (recent.length >= MAX_REQUESTS_PER_WINDOW) return true;
  recent.push(now);
  globalThis.__lifeNavigatorRateLimits.set(ip, recent);
  return false;
}

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function readJsonContent(content) {
  const text = Array.isArray(content)
    ? content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('')
    : String(content || '');

  const withoutFence = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start === -1 || end === -1) return null;

  try {
    return JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeAnalysis(value, goal) {
  const fallbackQuestions = [
    `你希望今天把“${goal}”推进到什么程度？`,
    '当前最大的未知、阻力或风险是什么？',
    '如果只做一步，哪一步能产生最有价值的新信息？',
  ];
  const fallbackActions = ['定义今天完成的最小证据', '完成一个可逆的小行动并记录结果'];

  const questions = Array.isArray(value?.questions)
    ? value.questions.map((item) => cleanText(item, 160)).filter(Boolean).slice(0, 3)
    : [];
  const nextActions = Array.isArray(value?.nextActions)
    ? value.nextActions.map((item) => cleanText(item, 120)).filter(Boolean).slice(0, 2)
    : [];

  while (questions.length < 3) questions.push(fallbackQuestions[questions.length]);
  while (nextActions.length < 2) nextActions.push(fallbackActions[nextActions.length]);

  return {
    summary: cleanText(value?.summary, 240) || `先澄清“${goal}”的完成边界，再用小行动获得真实反馈。`,
    questions,
    why:
      cleanText(value?.why, 360) ||
      '先处理最关键的不确定性，可以减少无效投入；拿到真实反馈后，再由你决定是否继续。',
    nextActions,
    risks: Array.isArray(value?.risks)
      ? value.risks.map((item) => cleanText(item, 120)).filter(Boolean).slice(0, 2)
      : [],
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: '只支持 POST 请求' });
  }

  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return res.status(403).json({ error: '请求来源不被允许' });
    } catch {
      return res.status(403).json({ error: '请求来源无效' });
    }
  }

  if (isRateLimited(req)) {
    return res.status(429).json({ error: '请求太频繁，请十分钟后再试' });
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ error: '服务器尚未配置 OpenRouter Key' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: '请求格式无效' });
    }
  }

  const goal = cleanText(body?.goal, 600);
  const answers = Array.isArray(body?.answers)
    ? body.answers.map((answer) => cleanText(answer, 600)).slice(0, 3)
    : [];
  const questions = Array.isArray(body?.questions)
    ? body.questions.map((question) => cleanText(question, 240)).filter(Boolean).slice(0, 3)
    : [];
  const sessionId = cleanText(body?.sessionId, 120);

  if (goal.length < 2) return res.status(400).json({ error: '请先写下一个具体任务' });

  const answerContext = answers.length
    ? `\n用户对澄清问题的回答：\n${answers
        .map((answer, index) =>
          answer ? `${index + 1}. ${questions[index] ? `${questions[index]}\n回答：` : ''}${answer}` : '',
        )
        .filter(Boolean)
        .join('\n')}`
    : '';

  const systemPrompt = `你是“人生任务提示器”的 AI 副驾驶。你的职责不是替用户做决定，而是帮助用户澄清目标、识别关键未知、缩小行动范围并获得真实反馈。

请遵守：
1. 使用简洁、自然的中文，避免空洞鼓励。
2. 生成三个真正有区分度的澄清问题。
3. 给出两个小而明确、可执行、尽量可逆的下一步。
4. 解释为什么现在优先这些动作，但把决策权留给用户。
5. 只输出 JSON，不要 Markdown，不要代码围栏。

JSON 结构：
{"summary":"一句话判断","questions":["问题1","问题2","问题3"],"why":"优先逻辑","nextActions":["行动1","行动2"],"risks":["风险1","风险2"]}`;

  try {
    const model = process.env.OPENROUTER_MODEL || 'openrouter/auto';
    const requestBody = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `我想推进的任务是：${goal}${answerContext}` },
      ],
      temperature: 0.45,
      max_tokens: 700,
    };
    if (sessionId) requestBody.session_id = sessionId;
    if (model === 'openrouter/auto') {
      requestBody.plugins = [{ id: 'auto-router', cost_quality_tradeoff: 9 }];
    }

    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': origin || `https://${host}`,
        'X-Title': 'Life Task Navigator',
      },
      body: JSON.stringify(requestBody),
    });

    const payload = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      console.error('OpenRouter request failed', upstream.status, JSON.stringify(payload).slice(0, 800));
      return res.status(502).json({ error: 'AI 服务暂时不可用，请稍后再试' });
    }

    const content = payload?.choices?.[0]?.message?.content;
    const parsed = readJsonContent(content);
    return res.status(200).json(normalizeAnalysis(parsed, goal));
  } catch (error) {
    console.error('Analyze function failed', error);
    return res.status(500).json({ error: '生成建议时发生错误，请稍后再试' });
  }
};
