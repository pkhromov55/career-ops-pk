// Анализ еды через Claude: фото и/или текст -> блюда, граммовки, калории, БЖУ.
// Использует официальный SDK Anthropic; ANTHROPIC_API_KEY задаётся в Vercel env.
import Anthropic from "@anthropic-ai/sdk";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items", "total", "comment"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "grams", "kcal", "protein", "fat", "carbs"],
        properties: {
          name: { type: "string" },
          grams: { type: "number" },
          kcal: { type: "number" },
          protein: { type: "number" },
          fat: { type: "number" },
          carbs: { type: "number" },
        },
      },
    },
    total: {
      type: "object",
      additionalProperties: false,
      required: ["kcal", "protein", "fat", "carbs"],
      properties: {
        kcal: { type: "number" },
        protein: { type: "number" },
        fat: { type: "number" },
        carbs: { type: "number" },
      },
    },
    comment: { type: "string" },
  },
};

const SYSTEM =
  "Ты — опытный нутрициолог. Оценивай еду по фото и/или текстовому описанию: " +
  "распознай блюда, реалистично оцени массу порций в граммах и посчитай калории и БЖУ " +
  "по стандартным таблицам продуктов. Если данных мало — дай лучшую разумную оценку " +
  "среднего варианта, не отказывайся. Названия блюд пиши по-русски. " +
  "В comment дай одно короткое замечание: что влияет на точность оценки или полезный совет.";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method-not-allowed" });
  }

  const pin = process.env.APP_PIN;
  if (pin && req.headers["x-pin"] !== pin) {
    return res.status(401).json({ error: "pin-required" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: "no-llm",
      hint: "Добавь ANTHROPIC_API_KEY в Vercel → Settings → Environment Variables и сделай Redeploy",
    });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = (body.text || "").toString().slice(0, 2000);
  const image = typeof body.image === "string" ? body.image : null;
  if (!text && !image) {
    return res.status(400).json({ error: "empty", hint: "Нужен текст или фото" });
  }

  const content = [];
  if (image) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: body.media_type || "image/jpeg",
        data: image,
      },
    });
  }
  content.push({
    type: "text",
    text: text
      ? "Посчитай эту еду. Комментарий пользователя: " + text
      : "Посчитай еду на фото.",
  });

  // Два режима: cheap = Haiku 4.5 (~$0.005-0.01 за анализ), best = Opus 5 (~$0.03-0.04).
  const mode = body.mode === "best" ? "best" : "cheap";
  const model =
    process.env.ANTHROPIC_MODEL ||
    (mode === "best" ? "claude-opus-5" : "claude-haiku-4-5");
  const outputConfig = { format: { type: "json_schema", schema: SCHEMA } };
  // effort поддерживается на Opus 5, но не на Haiku 4.5
  if (mode === "best") outputConfig.effort = "low";

  const client = new Anthropic();
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 8000,
      system: SYSTEM,
      output_config: outputConfig,
      messages: [{ role: "user", content }],
    });

    if (response.stop_reason === "refusal") {
      return res.status(422).json({
        error: "refused",
        hint: "Модель отклонила запрос — попробуй другое фото или описание",
      });
    }

    const block = response.content.find((b) => b.type === "text");
    if (!block) return res.status(502).json({ error: "llm-empty" });
    return res.status(200).json(JSON.parse(block.text));
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      return res.status(502).json({ error: "llm-auth", hint: "Неверный ANTHROPIC_API_KEY" });
    }
    if (e instanceof Anthropic.RateLimitError) {
      return res.status(502).json({ error: "llm-rate-limit", hint: "Лимит запросов к Claude — попробуй через минуту" });
    }
    if (e instanceof Anthropic.APIError) {
      return res.status(502).json({ error: "llm-failed", hint: String(e.message || "").slice(0, 300) });
    }
    return res.status(502).json({ error: "llm-failed", hint: String((e && e.message) || "unknown").slice(0, 300) });
  }
}
