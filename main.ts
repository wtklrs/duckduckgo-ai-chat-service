import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { Chat, initChat, Model } from "@mumulhl/duckduckgo-ai-chat";
import { events } from "jsr:@lukeed/fetch-event-stream";
import { rateLimiter } from "npm:hono-rate-limiter";

type Messages = { content: string; role: "user" | "assistant" | "system" }[];

const app = new Hono();

const chatCache = new Map<string, Chat>();

const token = Deno.env.get("TOKEN");
if (token) {
  app.use("/v1/*", bearerAuth({ token }));
}

const limit_var = Deno.env.get("LIMIT");
let limit = 2;
if (limit_var !== undefined) {
  limit = Number(limit_var);
}
const limiter = rateLimiter({
  windowMs: 1000,
  limit,
  standardHeaders: "draft-6",
  keyGenerator: (_) => "1",
});

app.use("/v1/*", limiter);

function setCache(messages: Messages, chat: Chat) {
  const messages_only_content = messages.map((m) => m.content);
  const stringify = JSON.stringify(messages_only_content);
  chatCache.set(stringify, chat);
}

function findCache(messages: Messages): Chat | undefined {
  const messages_only_content = messages.map((m) => m.content);
  const stringifyRedo = JSON.stringify(messages_only_content);
  let chat = chatCache.get(stringifyRedo);
  if (chat) {
    // redo
    return chat;
  } else {
    messages_only_content.pop();
    const stringify = JSON.stringify(messages_only_content);
    chat = chatCache.get(stringify);
    removeCache(messages);
    return chat;
  }
}

function removeCache(messages: Messages) {
  const stringify = JSON.stringify(messages);
  chatCache.delete(stringify);
}

async function fetchFull(chat: Chat, messages: Messages) {
  let message;
  let text;
  let messageData;

  for (let i = 0; i < messages.length; i += 2) {
    text = "";

    const content = messages[i]["content"];
    message = await chat.fetch(content);

    const stream = events(message as Response);
    for await (const event of stream) {
      if (event.data) {
        messageData = JSON.parse(event.data);
        if (messageData["message"] == undefined) {
          break;
        } else {
          text += messageData["message"];
        }
      }
    }

    const newVqd = message.headers.get("x-vqd-4") as string;
    chat.oldVqd = chat.newVqd;
    chat.newVqd = newVqd;

    chat.messages.push({ content: text, role: "assistant" });
  }

  const { id, created, model } = messageData;

  return { id, created, model, text };
}

app.post("/v1/chat/completions", async (c) => {
  const body = await c.req.json();
  const model_name: Model = body["model"];
  let messages: Messages = body["messages"];

  if (messages[0]["role"] === "system") {
    messages[1]["content"] = messages[0]["content"] + messages[1]["content"];
    messages = messages.slice(1);
  }

  let chat = findCache(messages);
  if (chat == undefined) {
    chat = await initChat(model_name);
  }

  // For redo
  if (chat.messages.length >= 3) {
    const chatRedo = structuredClone(chat);
    setCache(chat.messages, chatRedo);
  }

  const { id, model, created, text } = await fetchFull(chat, messages);

  if (chat.messages.length >= 4) {
    setCache(chat.messages, chat);
  }

  return c.json({
    id,
    model,
    created,
    choices: [{
      "message": { "role": "assistant", "content": text },
    }],
  });
});

Deno.serve(app.fetch);
