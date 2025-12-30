require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const bot = new Telegraf(process.env.BOT_TOKEN);

function normalizeLayout(str) {
    if (typeof str !== 'string') return '';
    return str
        .toLowerCase()
        .replace(/a/g, 'а')
        .replace(/e/g, 'е')
        .replace(/o/g, 'о')
        .replace(/p/g, 'р')
        .replace(/c/g, 'с')
        .replace(/y/g, 'у')
        .replace(/x/g, 'х')
        .replace(/k/g, 'к')
        .replace(/m/g, 'м')
        .replace(/n/g, 'н')
        .replace(/t/g, 'т')
        .replace(/b/g, 'в')
        .replace(/[^а-яё\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function escapeLike(text) {
    return text.replace(/[%_]/g, '\\$&');
}

function parseCommandArgs(text) {
    return text.split(/\s+/).slice(1).filter(x => x.trim() !== '');
}

function extractUsernameAndRest(args) {
    if (args.length === 0) return { username: null, words: [] };
    const first = args[0];
    if (first.startsWith('@') && first.length > 1) {
        return { username: first.slice(1), words: args.slice(1) };
    }
    return { username: null, words: args };
}

bot.command('help', (ctx) => {
    const helpMessage = `
*Статистика чата* — бот для анализа слов в переписке

*Основные команды:*

• \`/stat [слово|фраза] \`  
  Сколько раз *«слово»* встречалось в чате.

• \`/stat @username слово\`  
  Сколько раз *пользователь* написал это слово.

• \`/top [week|month|year|all]\`  
  Топ-5 самых частых слов за указанный период.  
  Пример: \`/top month\`

• \`/top @username\`  
  Топ-5 слов конкретного пользователя.

• \`/top слово1 слово2 слово3\`  
  Сравнить частоту нескольких слов — отсортировано по убыванию.

• \`/top week @alice привет пока\`  
  Сколько раз *alice* писала «привет» и «пока» *за неделю*.

[Исходный код на GitHub](https://github.com/Kdzefuf/words-stat-bot)
  `;

    return ctx.reply(helpMessage, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
    });
});

bot.command('stat', async (ctx) => {
    const args = parseCommandArgs(ctx.message.text);
    if (args.length === 0) {
        return ctx.reply(
            '📌 Используйте:\n`/stat слово`\n`/stat @username слово`\n`/stat фраза из нескольких слов`',
            { parse_mode: 'Markdown' }
        );
    }

    const { username, words } = extractUsernameAndRest(args);
    const query = words.join(' ').trim();
    if (!query) {
        return ctx.reply('📌 Укажите слово или фразу.');
    }

    const normQuery = normalizeLayout(query);
    let sql, params;

    if (words.length > 1) {
        sql = `
      SELECT COUNT(*) AS count
      FROM chat_messages m
      WHERE m.chat_id = $1
        AND m.normalized_text LIKE $2
    `;
        params = [ctx.chat.id, `%${escapeLike(normQuery)}%`];

    } else {
        sql = `
      SELECT COUNT(*) AS count
      FROM chat_messages m,
           regexp_split_to_table(m.normalized_text, '\\s+') AS word
      WHERE m.chat_id = $1
        AND word LIKE $2
    `;
        params = [ctx.chat.id, `${normQuery}%`];
    }

    if (username) {
        sql += ` AND (m.username = $${params.length + 1} OR LOWER(m.author_name) = $${params.length + 1})`;
        params.push(username.toLowerCase());
    }

    try {
        const res = await pool.query(sql, params);
        const n = parseInt(res.rows[0].count, 10);
        const target = username ? `у @${username}` : 'в чате';

        if (words.length > 1) {
            ctx.reply(`🔍 Фраза «${query}» найдена *${n}* раз(а) ${target}.`, {
                parse_mode: 'Markdown',
            });
        } else {
            ctx.reply(`🔍 Слов, начинающихся с «${query}»: *${n}* раз(а) ${target}.`, {
                parse_mode: 'Markdown',
            });
        }
    } catch (e) {
        console.error('/stat error:', e);
        ctx.reply('⚠️ Ошибка при подсчёте.');
    }
});

bot.command('top', async (ctx) => {
    const args = parseCommandArgs(ctx.message.text);
    if (args.length === 0) {
        return ctx.reply(
            '`/top week|month|year|all`\n' +
            '`/top @username`\n' +
            '`/top слово1 слово2`\n' +
            '`/top @username слово1 слово2`',
            { parse_mode: 'Markdown' }
        );
    }

    const periods = { week: 7, month: 30, year: 365, all: null };
    let days = null;
    let remainingArgs = args;

    if (args.length > 0 && args[0] in periods) {
        days = periods[args[0]];
        remainingArgs = args.slice(1);
    }

    const { username, words } = extractUsernameAndRest(remainingArgs);

    try {
        if (words.length > 0) {
            const normWords = words.map(w => normalizeLayout(w));
            const results = [];

            for (let i = 0; i < normWords.length; i++) {
                const prefix = normWords[i];
                let sql = `
      SELECT COUNT(*) AS count
      FROM chat_messages m,
           regexp_split_to_table(m.normalized_text, '\\s+') AS word
      WHERE m.chat_id = $1
        AND word LIKE $2
    `;
                let params = [ctx.chat.id, `${prefix}%`];
                let paramIndex = 3;

                if (days !== null) {
                    sql += ` AND m.created_at >= NOW() - make_interval(days => $${paramIndex})`;
                    params.push(days);
                    paramIndex++;
                }

                if (username) {
                    sql += ` AND (m.username = $${paramIndex} OR LOWER(m.author_name) = $${paramIndex})`;
                    params.push(username.toLowerCase());
                }

                const res = await pool.query(sql, params);
                results.push({ word: words[i], count: parseInt(res.rows[0].count, 10) });
            }

            results.sort((a, b) => b.count - a.count);

            const list = results
                .filter(r => r.count > 0)
                .map((r, i) => `${i + 1}. *${r.word}* — ${r.count}`)
                .join('\n');

            if (list === '') return ctx.reply('📊 Нет данных по указанным словам.');

            const periodLabel = days === 7 ? 'неделю' : days === 30 ? 'месяц' : days === 365 ? 'год' : 'всё время';
            const userLabel = username ? ` у @${username}` : '';
            ctx.reply(`🔝 Частота слов за ${periodLabel}${userLabel}:\n${list}`, {
                parse_mode: 'Markdown',
            });
        } else {
            let sql = `
        WITH words AS (
          SELECT UNNEST(
            REGEXP_SPLIT_TO_ARRAY(normalized_text, '\\s+')
          ) AS word
          FROM chat_messages
          WHERE chat_id = $1
      `;
            let params = [ctx.chat.id];
            let paramIndex = 2;

            if (days !== null) {
                sql += ` AND created_at >= NOW() - make_interval(days => $${paramIndex})`;
                params.push(days);
                paramIndex++;
            }

            if (username) {
                sql += ` AND (username = $${paramIndex} OR LOWER(author_name) = $${paramIndex})`;
                params.push(username.toLowerCase());
                paramIndex++;
            }

            sql += `
        )
        SELECT word, COUNT(*) AS freq
        FROM words
        WHERE word != '' AND LENGTH(word) >= 4
        GROUP BY word
        ORDER BY freq DESC
        LIMIT 5;
      `;

            const res = await pool.query(sql, params);

            if (res.rows.length === 0) return ctx.reply('📊 Нет данных.');

            const periodNames = { 7: 'неделю', 30: 'месяц', 365: 'год', null: 'всё время' };
            const periodLabel = periodNames[days] || periodNames[null];
            const userLabel = username ? ` у @${username}` : '';
            const list = res.rows.map((r, i) => `${i + 1}. *${r.word}* — ${r.freq}`).join('\n');
            ctx.reply(`🔝 Топ-5 слов за ${periodLabel}${userLabel}:\n${list}`, {
                parse_mode: 'Markdown',
            });
        }
    } catch (e) {
        console.error('/top error:', e);
        ctx.reply('Ошибка при формировании рейтинга.');
    }
});

bot.on('text', async (ctx) => {
    if (!ctx.chat || ctx.chat.type === 'private' || ctx.chat.type === 'channel') return;

    const { chat, from, message } = ctx;
    const chatId = chat.id;
    const messageId = message.message_id;
    const text = message.text;
    const userId = from.id;
    const authorName = from.first_name || (from.username ? `@${from.username}` : 'неизвестно');
    const username = from.username;
    const normalizedText = normalizeLayout(text);

    try {
        await pool.query(
            `INSERT INTO chat_messages 
        (chat_id, message_id, user_id, author_name, username, text, normalized_text, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (chat_id, message_id) DO NOTHING`,
            [chatId, messageId, userId, authorName, username, text, normalizedText]
        );
    } catch (err) {
        console.error('Ошибка сохранения:', err.message);
    }
});

bot.launch().then(() => {
    console.log('Бот запущен.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));