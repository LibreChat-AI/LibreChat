const mongoose = require('mongoose');

const ago = (days) => new Date(Date.now() - days * 24 * 3600 * 1000);

/**
 * Parses `from`/`to`/`days` query params into a Mongo date range.
 * Returns `{ range, prevRange }` where `prevRange` is the immediately
 * preceding period of equal length (used for `compare=prev`).
 */
function parseDateRange(query, defaultDays = 30) {
  let $gte;
  let $lte = new Date();
  if (query.from) {
    $gte = new Date(`${query.from}T00:00:00+09:00`);
    if (query.to) {
      $lte = new Date(`${query.to}T23:59:59+09:00`);
    }
  } else {
    const days = Math.max(1, Math.min(parseInt(query.days, 10) || defaultDays, 365));
    $gte = ago(days);
  }
  const spanMs = $lte.getTime() - $gte.getTime();
  const prevRange = {
    $gte: new Date($gte.getTime() - spanMs),
    $lt: $gte,
  };
  return { range: { $gte, $lte }, prevRange };
}

function getDb() {
  const conn = mongoose.connection;
  if (!conn || conn.readyState !== 1) {
    throw new Error(`MongoDB not connected (readyState=${conn && conn.readyState})`);
  }
  return conn.db;
}

async function loadUsers(db, userIds, projection) {
  const userOids = [];
  for (const userId of userIds) {
    try {
      userOids.push(new mongoose.Types.ObjectId(userId));
    } catch {
      // Skip non-ObjectId values.
    }
  }

  if (!userOids.length) {
    return new Map();
  }

  const users = await db
    .collection('users')
    .find({ _id: { $in: userOids } }, { projection })
    .toArray();
  return new Map(users.map((user) => [String(user._id), user]));
}

/**
 * 대화의 메시지를 시간순으로 읽어 역할/본문만 남긴 형태로 반환한다.
 * `text` 가 비어 있고 본문이 `content[]` 파트로만 들어온 경우도 흡수한다.
 *
 * 소프트 삭제(`bklDeletedAt`) 여부를 보지 않는다 — 호출하는 라우트가
 * 무엇을 열어줄지 판단한다.
 */
async function loadConversationMessages(db, conversationId) {
  const msgs = await db
    .collection('messages')
    .find(
      { conversationId },
      {
        projection: {
          messageId: 1,
          isCreatedByUser: 1,
          text: 1,
          content: 1,
          createdAt: 1,
          model: 1,
          sender: 1,
        },
      },
    )
    .sort({ createdAt: 1 })
    .toArray();

  return msgs.map((msg) => {
    let text = msg.text || '';
    if (!text && Array.isArray(msg.content)) {
      text = msg.content
        .filter((content) => content && content.type === 'text')
        .map((content) => content.text || '')
        .join('\n')
        .trim();
    }
    return {
      // 질의 이력(bkl_query_logs.messageId)과 짝을 맞춰 "이 질의의 답변"을 찾는 데 쓴다.
      messageId: msg.messageId || null,
      role: msg.isCreatedByUser ? 'user' : 'assistant',
      text,
      createdAt: msg.createdAt,
      model: msg.model || null,
    };
  });
}

module.exports = { ago, parseDateRange, getDb, loadUsers, loadConversationMessages };
