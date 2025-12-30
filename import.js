require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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

function parseArgs() {
    const args = process.argv.slice(2);
    let chatId = parseInt(process.env.CHAT_ID, 10);
    let filePath = null;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--chat-id' && args[i + 1]) {
            chatId = parseInt(args[i + 1], 10);
            i++;
        } else if (!filePath && !args[i].startsWith('-')) {
            filePath = args[i];
        }
    }

    if (!filePath) {
        console.error('Укажите путь к файлу экспорта.');
        console.error('Использование: node import.js [--chat-id <ID>] <путь_к_chat_export.json>');
        process.exit(1);
    }

    if (isNaN(chatId)) {
        console.error('Укажите chat_id через --chat-id или в .env как CHAT_ID');
        process.exit(1);
    }

    return { chatId, filePath };
}

async function importChat(chatId, jsonPath) {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const data = JSON.parse(raw);
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        let inserted = 0;
        for (const msg of data.messages) {
            if (msg.type !== 'message' || typeof msg.text !== 'string') continue;

            const messageId = msg.id || null;
            const text = msg.text;
            const date = new Date(msg.date);

            let userId = null;
            let username = null;
            let authorName = msg.from || 'unknown';

            if (msg.from_id && typeof msg.from_id === 'string') {
                const match = msg.from_id.match(/^user(\d+)$/);
                if (match) {
                    userId = parseInt(match[1], 10);
                }
            }

            if (authorName && authorName.includes('@')) {
                const unameMatch = authorName.match(/@([a-zA-Z0-9_]{1,32})/);
                if (unameMatch) {
                    username = unameMatch[1];
                }
            }

            const normalizedText = normalizeLayout(text);

            const query = `
        INSERT INTO chat_messages 
          (chat_id, message_id, user_id, author_name, username, text, normalized_text, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (chat_id, message_id) DO NOTHING
      `;
            const values = [
                chatId,
                messageId,
                userId,
                authorName,
                username,
                text,
                normalizedText,
                date
            ];

            const res = await client.query(query, values);
            inserted += res.rowCount;
        }

        await client.query('COMMIT');
        console.log(`Обработано ${data.messages.length} сообщений.`);
        console.log(`Вставлено: ${inserted}, пропущено (дубли): ${data.messages.length - inserted}`);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Ошибка импорта:', err);
        if (err.detail) console.error('  💡', err.detail);
    } finally {
        client.release();
        await pool.end();
    }
}

const { chatId, filePath } = parseArgs();
console.log(`🚀 Импорт в чат ID: ${chatId}`);
console.log(`📁 Файл: ${filePath}`);
importChat(chatId, filePath);