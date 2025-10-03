const fs = require("fs");
const path = require("path");
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const User = require("./models/User");
const Poll = require("./models/Poll");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const ADMIN_ID = process.env.ADMIN_ID
  ? process.env.ADMIN_ID.split(",").map(id => id.trim())
  : [];


//---------------

const filePat = path.join(process.cwd(), "subs.json");

function getAllChannelNames() {
  try {
    if (!fs.existsSync(filePat)) return [];
    const data = fs.readFileSync(filePat, "utf8");
    const subs = JSON.parse(data);
    
    // Return the actual array, not a string
    return subs.map(s => s.channel_name);
  } catch (error) {
    console.error('Error reading channel names:', error);
    return [];
  }
}


//---------------
const CHANNEL_IDS = getAllChannelNames();

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  });

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

transporter.verify((error, success) => {
  if (error) {
    console.error("❌ Email configuration error:", error);
  } else {
    console.log("✅ Email server ready");
  }
});

const tempData = new Map();
const userSteps = new Map();
const pollSessions = new Map();
const verificationCodeExpiry = new Map();

const validateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const generateVerificationCode = () => Math.floor(100000 + Math.random() * 900000).toString();
const cleanUserData = (userId) => {
  tempData.delete(userId);
  userSteps.delete(userId);
  verificationCodeExpiry.delete(userId);
};


async function isUserSubscribed(userId) {
  if (!CHANNEL_IDS.length) return true;

  try {
    for (const channel of CHANNEL_IDS) {
      const member = await bot.getChatMember(channel, userId);
      if (!["member", "administrator", "creator"].includes(member.status)) {
        return false; 
      }
    }
    return true; 
  } catch (err) {
    console.error(`❌ Error checking subscription for ${userId}:`, err.message);
    return false;
  }
}


async function sendVerificationEmail(to, code) {
  try {
    await transporter.sendMail({
      from: `"Telegram Bot" <${process.env.EMAIL_USER}>`,
      to,
      subject: "Tasdiqlash kodi",
      text: `Sizning tasdiqlash kodingiz: ${code}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; padding: 20px; border: 1px solid #e5e5e5; border-radius: 10px; background: #f9f9f9;">
          <h2 style="color: #333; text-align: center;">👋 Salom!</h2>
          <p style="font-size: 16px; color: #555; text-align: center;">
            Sizning tasdiqlash kodingiz quyida berilgan:
          </p>
          <div style="text-align: center; margin: 20px 0;">
            <span style="display: inline-block; font-size: 24px; letter-spacing: 4px; color: #fff; background: #007BFF; padding: 12px 24px; border-radius: 8px;">
              ${code}
            </span>
          </div>
          <p style="font-size: 14px; color: #777; text-align: center;">
            Ushbu kod <b>5 daqiqa</b> davomida amal qiladi. Iltimos, uni hech kim bilan ulashmang.
          </p>
        </div>
      `
    });
    return true;
  } catch (err) {
    console.error("❌ Email sending error:", err.message);
    return false;
  }
}

function splitMessage(text, maxLength = 4000) {
  const parts = [];
  for (let i = 0; i < text.length; i += maxLength) {
    parts.push(text.substring(i, i + maxLength));
  }
  return parts;
}

async function safeMessageSend(bot, chatId, text) {
  const messages = splitMessage(text);
  for (const msg of messages) {
    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
  }
}


async function safeMessageEdit(chatId, messageId, text, options = {}) {
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      ...options
    });
  } catch (err) {
    console.error(`❌ Failed to edit message in ${chatId}:`, err.message);
    return null;
  }
}

console.log("🤖 Bot started successfully!");

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!userId) {
    return safeMessageSend(chatId, "❌ Foydalanuvchi ma'lumotlari topilmadi.");
  }

  try {
    const existingUser = await User.findOne({ userId: userId });
    if (existingUser) {
      return safeMessageSend(
        chatId,
        "✅ Siz allaqachon ro'yxatdan o'tgansiz.\n📊 Ma'lumotlaringiz bazada saqlangan."
      );
    }

    tempData.set(userId, {});
    userSteps.set(userId, "firstName");

    await safeMessageSend(chatId, "👋 Salom! Ro'yxatdan o'tish uchun ismingizni kiriting:");
  } catch (err) {
    console.error("❌ Start command error:", err);
    await safeMessageSend(chatId, "❌ Xatolik yuz berdi. Iltimos, qayta urinib ko'ring.");
  }
});


bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const step = userSteps.get(userId);
const parts = msg.text.split(' ');
  if (!step || !userId || msg.text?.startsWith("/")) return;

  try {
    const userData = tempData.get(userId) || {};

    switch (step) {
      case "firstName":
        if (!msg.text || msg.text.trim().length < 2) {
          return safeMessageSend(chatId, "❌ Iltimos, kamida 2 ta belgidan iborat ism kiriting:");
        }
        userData.firstName = msg.text.trim();
        tempData.set(userId, userData);
        userSteps.set(userId, "lastName");
        return safeMessageSend(chatId, "📝 Familiyangizni kiriting:");

      case "lastName":
        if (!msg.text || msg.text.trim().length < 2) {
          return safeMessageSend(chatId, "❌ Iltimos, kamida 2 ta belgidan iborat familiya kiriting:");
        }
        userData.lastName = msg.text.trim();
        tempData.set(userId, userData);
        userSteps.set(userId, "phone");
        return safeMessageSend(chatId, "📞 Telefon raqamingizni ulashish uchun tugmani bosing:", {
          reply_markup: {
            keyboard: [
              [{ text: "📲 Raqamni ulashish", request_contact: true }]
            ],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        });

      case "phone":
        if (msg.contact && msg.contact.user_id === userId) {
          userData.phone = msg.contact.phone_number;
          tempData.set(userId, userData);
          userSteps.set(userId, "email");
          return safeMessageSend(chatId, "📧 Email manzilingizni kiriting:", {
            reply_markup: { remove_keyboard: true }
          });
        } else if (!msg.contact) {
          return safeMessageSend(chatId, "❌ Iltimos, telefon raqamini ulashish tugmasini bosing.");
        } else {
          return safeMessageSend(chatId, "❌ Faqat o'zingizning telefon raqamingizni ulashing.");
        }

      case "email":
        if (!validateEmail(msg.text)) {
          return safeMessageSend(chatId, "❌ Iltimos, to'g'ri email manzil kiriting:");
        }

        const email = msg.text.toLowerCase().trim();
        
        const existingEmail = await User.findOne({ email: email });
        if (existingEmail) {
          return safeMessageSend(chatId, "❌ Bu email manzil allaqachon ro'yxatdan o'tgan.");
        }

        userData.email = email;
        
        const verificationCode = generateVerificationCode();
        userData.verificationCode = verificationCode;
        tempData.set(userId, userData);
        
        verificationCodeExpiry.set(userId, Date.now() + 5 * 60 * 1000); 
        userSteps.set(userId, "verifyEmail");

        const emailSent = await sendVerificationEmail(email, verificationCode);
        
        if (!emailSent) {
          return safeMessageSend(chatId, "❌ Email yuborishda xatolik yuz berdi. Iltimos, qayta urinib ko'ring.");
        }

        return safeMessageSend(
          chatId, 
          "✅ Email qabul qilindi!\n📩 Tasdiqlash kodi emailingizga yuborildi.\n\n🔢 Kodni kiriting (5 daqiqa ichida):"
        );

case "verifyEmail":
  if (Date.now() > verificationCodeExpiry.get(userId)) {
    cleanUserData(userId);
    return safeMessageSend(chatId, "❌ Tasdiqlash kodi muddati tugagan.\n🔄 /start buyrug'i bilan qayta boshlang.");
  }

  if (msg.text === userData.verificationCode) {
    userData.emailVerified = true;

    try {
      const filter = { userId }; 
      const update = {
        $setOnInsert: {
          userId,
          telegramId: userId,            
          createdAt: new Date()
        },
        $set: {
          firstName: userData.firstName,
          lastName: userData.lastName,
          phone: userData.phone,
          email: userData.email,
          emailVerified: userData.emailVerified,
          updatedAt: new Date()
        }
      };
      const options = { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true };

      let newUser;
      try {
        newUser = await User.findOneAndUpdate(filter, update, options);
      } catch (err) {
        if (err && err.code === 11000 && (err.keyPattern?.telegramId || String(err).includes('telegramId'))) {
          console.warn("🧹 Duplicate key on telegramId (null) detected — cleaning nulls and retrying...");
          await User.deleteMany({ telegramId: null });
          newUser = await User.findOneAndUpdate(filter, update, options);
        } else {
          throw err;
        }
      }

      cleanUserData(userId);

      await safeMessageSend(
        chatId,
        "🎉 Tabriklaymiz!\n✅ Emailingiz tasdiqlandi va ma'lumotlaringiz saqlandi.\n\n🤖 Endi botdan to'liq foydalanishingiz mumkin!"
      );
    } catch (err) {
      console.error("❌ Saving user error:", err);
      if (err && err.code === 11000) {
        await safeMessageSend(chatId, "❌ Bazaga yozishda unique index xatosi yuz berdi. Iltimos, admin bilan bog'laning.");
      } else {
        await safeMessageSend(chatId, "❌ Xatolik yuz berdi. /start bilan qayta boshlang.");
      }
      cleanUserData(userId);
    }
  } else {
    return safeMessageSend(chatId, "❌ Xato kod. Qayta urinib ko'ring:");
  }
  break;


      default:
        cleanUserData(userId);
        break;
    }
  } catch (err) {
    console.error("❌ Registration flow error:", err);
    cleanUserData(userId);
    await safeMessageSend(chatId, "❌ Xatolik yuz berdi. /start bilan qayta boshlang.");
  }
});

bot.onText(/\/poll/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from?.id);

  if (!userId || !ADMIN_ID.includes(userId)) {
    return safeMessageSend(chatId, "❌ Bu buyruqni faqat admin ishlatishi mumkin.");
  }

  if (pollSessions.has(userId)) {
    return safeMessageSend(chatId, "❌ Sizda allaqachon faol sorovnoma sessiyasi mavjud.\n🛑 Avval uni yakunlang yoki /cancel_poll bilan bekor qiling.");
  }

  pollSessions.set(userId, { step: "question", options: [] });
  await safeMessageSend(chatId, "❓ Sorovnoma savolini yuboring:");
});

bot.onText(/\/cancel_poll/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from?.id);

  if (!userId || !ADMIN_ID.includes(userId)) {
    return safeMessageSend(chatId, "❌ Bu buyruqni faqat admin ishlatishi mumkin.");
  }

  if (pollSessions.has(userId)) {
    pollSessions.delete(userId);
    await safeMessageSend(chatId, "✅ Sorovnoma sessiyasi bekor qilindi.");
  } else {
    await safeMessageSend(chatId, "❌ Faol sorovnoma sessiyasi topilmadi.");
  }
});

bot.onText(/\/allpoll/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from?.id);

  if (!ADMIN_ID.includes(userId)) {
    return safeMessageSend(chatId, "❌ Sizda bu komanda uchun ruxsat yo'q.");
  }

  try {
    const polls = await Poll.find().sort({ createdAt: -1 });

    if (!polls.length) {
      return safeMessageSend(chatId, "📭 Hozircha hech qanday sorovnoma yo‘q.");
    }

    for (let i = 0; i < polls.length; i++) {
      const poll = polls[i];
      const text =
        `📊 *${i + 1}. ${poll.question}*\n\n` +
        `🗳 Variantlar: ${poll.options.length} ta\n` +
        `⏰ Tugash vaqti: ${poll.expiresAt.toLocaleString("uz-UZ", { timeZone: "Asia/Tashkent" })}\n` +
        `🔵 Holat: ${poll.active ? "Aktiv" : "Yopilgan"}`;

      await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
    }
  } catch (err) {
    console.error("❌ Poll list error:", err);
    return safeMessageSend(chatId, "❌ Sorovnomalarni olishda xatolik yuz berdi.");
  }
});

bot.onText(/\/clearpoll/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from?.id);

  if (!ADMIN_ID.includes(userId)) {
    return safeMessageSend(chatId, "❌ Sizda bu komanda uchun ruxsat yo'q.");
  }

  try {
    const result = await Poll.deleteMany({});
    return safeMessageSend(chatId, `🗑 ${result.deletedCount} ta sorovnoma o‘chirildi.`);
  } catch (err) {
    console.error("❌ Poll clear error:", err);
    return safeMessageSend(chatId, "❌ Sorovnomalarni o‘chirishda xatolik yuz berdi.");
  }
});

//-------------------------------------------------------


// JSON fayl joyi
const filePath = path.join(process.cwd(), "subs.json");

// JSONni o‘qish
function readSubs() {
  if (!fs.existsSync(filePath)) return [];
  const data = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// JSONga yozish
function writeSubs(subs) {
  fs.writeFileSync(filePath, JSON.stringify(subs, null, 2), "utf8");
}

// Admin step state (faqat admin uchun) safeMessageSend
const adminSteps = new Map();

bot.on("message", async (msg) => {
  const userId = msg.from?.id;
  const text = msg.text?.trim();

  if (!userId || !text) return;

  const step = adminSteps.get(userId);

  if (step === "waitingForChannelName" && text.startsWith("@")) {
    adminSteps.delete(userId);

    try {
      let subs = readSubs().sort((a, b) => a.id - b.id);
      let newId = 1;

      for (let i = 0; i < subs.length; i++) {
        if (subs[i].id !== i + 1) {
          newId = i + 1;
          break;
        }
        newId = subs.length + 1;
      }

      const newSub = { id: newId, channel_name: text };
      subs.push(newSub);
      subs.sort((a, b) => a.id - b.id);
      writeSubs(subs);

      return bot.sendMessage(
        msg.chat.id,
        `✅ Saqlandi:\nID: ${newId}\nChannel: ${text}`
      );
    } catch (err) {
      return bot.sendMessage(msg.chat.id, "❌ Saqlashda xato: " + err.message);
    }
  }
});

// /create_sub
bot.onText(/\/create_sub/, (msg) => {
  const userId = String(msg.from?.id);
  if (!userId || !ADMIN_ID.includes(userId)) return;
  adminSteps.set(msg.from.id, "waitingForChannelName");
  bot.sendMessage(msg.chat.id, "Kanal nomini yuboring (masalan: @salom)");
});

// /all_sub
bot.onText(/\/all_sub/, (msg) => {
  const userId = String(msg.from?.id);
  if (!userId || !ADMIN_ID.includes(userId)) return;

  const subs = readSubs().sort((a, b) => a.id - b.id);
  if (subs.length === 0) {
    bot.sendMessage(msg.chat.id, "Hozircha hech narsa yo‘q.");
  } else {
    let text = "📋 Barcha subs:\n\n";
    subs.forEach((s) => {
      text += `${s.id}. ${s.channel_name}\n`;
    });
    bot.sendMessage(msg.chat.id, text);
  }
});


// /delete_sub id
bot.onText(/\/delete (\d+)/, (msg, match) => {
  const userId = String(msg.from?.id);
  if (!userId || !ADMIN_ID.includes(userId)) return;

  const id = Number(match[1]);
  const subs = readSubs();

  const sub = subs.find(s => s.id === id);
  
  if (!sub) {
    return bot.sendMessage(userId, `❌ ID ${id} topilmadi.`);
  }

  writeSubs(subs.filter(s => s.id !== id));
  return bot.sendMessage(
    userId,
    `🗑 O'chirildi!\nID: ${sub.id}\nChannel: ${sub.channel_name}`
  );
});



//-------------------------------------------------------


async function safePhotoSend(chatId, fileId, caption, options = {}) {
  try {
    await bot.sendPhoto(chatId, fileId, { caption, ...options });
    return true;
  } catch (err) {
    console.error(`❌ Rasm yuborishda xatolik (${chatId}):`, err);
    return false;
  }
}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from?.id);

  if (!userId || !ADMIN_ID.includes(userId) || !pollSessions.has(userId) || msg.text?.startsWith("/")) return;

  const session = pollSessions.get(userId);

  try {
    switch (session.step) {
      case "question": {
        if (msg.photo) {
          const photo = msg.photo[msg.photo.length - 1]; 
          session.imageFileId = photo.file_id;

          if (!msg.caption || msg.caption.trim().length < 3) {
            return safeMessageSend(chatId, "❌ Rasm yuborganda ham caption sifatida kamida 3 ta belgidan iborat savol kiriting:");
          }
          session.question = msg.caption.trim();
        } else if (msg.text) {
          if (msg.text.trim().length < 3) {
            return safeMessageSend(chatId, "❌ Kamida 3 ta belgidan iborat savol kiriting:");
          }
          session.question = msg.text.trim();
          session.imageFileId = null;
        } else {
          return safeMessageSend(chatId, "❌ Savol text yoki rasm+caption ko‘rinishida bo‘lishi kerak:");
        }

        session.step = "options";
        pollSessions.set(userId, session);

        return safeMessageSend(chatId, "📝 Birinchi variantni yuboring:", {
          reply_markup: { inline_keyboard: [[{ text: "❌ Bekor qilish", callback_data: "cancel_poll" }]] }
        });
      }

      case "options": {
        if (!msg.text || msg.text.trim().length < 1) {
          return safeMessageSend(chatId, "❌ Variant matnini kiriting:");
        }

        if (session.options.length >= 50) {
          return safeMessageSend(chatId, "❌ Maksimal 50 ta variant qo'shishingiz mumkin.");
        }

        session.options.push(msg.text.trim());
        pollSessions.set(userId, session);

        const keyboard = [];
        if (session.options.length >= 2) keyboard.push([{ text: "✅ Yakunlash", callback_data: "finish_options" }]);
        keyboard.push([{ text: "➕ Yana variant qo'shish", callback_data: "add_option" }]);
        keyboard.push([{ text: "❌ Bekor qilish", callback_data: "cancel_poll" }]);

        return safeMessageSend(chatId,
          `✅ Variant qo'shildi! (${session.options.length}/50)\n\n📋 Variantlar:\n${session.options.map((opt, i) => `${i + 1}. ${opt}`).join('\n')}`,
          { reply_markup: { inline_keyboard: keyboard } }
        );
      }

      case "duration": {
        const minutes = parseInt(msg.text);
        if (isNaN(minutes) || minutes <= 0 || minutes > 10080) {
          return safeMessageSend(chatId, "❌ 1 dan 10080 gacha daqiqa kiriting:");
        }

        const expiresAt = new Date(Date.now() + minutes * 60000);

        const poll = await Poll.create({
          question: session.question,
          imageFileId: session.imageFileId || null,
          options: session.options.map(opt => ({ text: opt, votes: 0 })),
          createdBy: userId,
          expiresAt,
          active: true,
          votes: new Map()
        });
        
        const users = await User.find({});
        const pollKeyboard = {
          inline_keyboard: [
            [{ text: "🗳 Ovoz berish", callback_data: `start_vote_${poll._id}` }],
            [{ text: "📤 Ulashish", switch_inline_query: `poll_${poll._id}` }]
          ]
        };

        for (const user of users) {
          if (poll.imageFileId) {
            await safePhotoSend(user.userId, poll.imageFileId, `📊 Yangi sorovnoma!\n\n❓ ${poll.question}`, { reply_markup: pollKeyboard });
          } else {
            await safeMessageSend(user.userId, `📊 Yangi sorovnoma!\n\n❓ ${poll.question}`, { reply_markup: pollKeyboard });
          }
        }

        await safeMessageSend(chatId, `✅ Sorovnoma yaratildi va ${users.length} foydalanuvchiga yuborildi.\n⏰ Tugash vaqti: ${expiresAt.toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' })}`);

        setTimeout(async () => {
          try {
            const expiredPoll = await Poll.findById(poll._id);
            if (expiredPoll && expiredPoll.active) {
              expiredPoll.active = false;
              await expiredPoll.save();
              await announceResults(expiredPoll);
            }
          } catch (err) {
            console.error("❌ Poll expiry error:", err);
          }
        }, minutes * 60000);

        pollSessions.delete(userId);
        break;
      }

      default:
        pollSessions.delete(userId);
        break;
    }
  } catch (err) {
    console.error("❌ Poll creation error:", err);
    pollSessions.delete(userId);
    await safeMessageSend(chatId, "❌ Sorovnoma yaratishda xatolik yuz berdi.");
  }
});

async function safeMessageSend(chatIdOrInlineId, text, options = {}) {
  try {
    if (typeof chatIdOrInlineId === "string") {
      return await bot.editMessageText(text, {
        inline_message_id: chatIdOrInlineId,
        ...options
      });
    } else {
      return await bot.sendMessage(chatIdOrInlineId, text, options);
    }
  } catch (err) {
    console.error("❌ safeMessageSend error:", err);
  }
}

async function safeMessageEdit(targetId, messageId, text, extra = {}) {
  try {
    if (!text || typeof text !== "string" || text.trim() === "") {
      console.error("❌ safeMessageEdit: text bo‘sh");
      return;
    }

    if (typeof targetId === "string") {
      return await bot.editMessageText(text, {
        inline_message_id: targetId,
        ...extra,
      }).catch(async (err) => {
        if (err.response?.body?.description?.includes("no text in the message")) {
          return await bot.editMessageCaption(text, {
            inline_message_id: targetId,
            ...extra,
          });
        }
        throw err;
      });
    } else {
      return await bot.editMessageText(text, {
        chat_id: targetId,
        message_id: messageId,
        ...extra,
      }).catch(async (err) => {
        if (err.response?.body?.description?.includes("no text in the message")) {
          return await bot.editMessageCaption(text, {
            chat_id: targetId,
            message_id: messageId,
            ...extra,
          });
        }
        throw err;
      });
    }
  } catch (e) {
    console.error("❌ safeMessageEdit error:", e.message);
  }
}


async function safeMessageSend(targetId, text, extra = {}) {
  try {
    if (typeof targetId === "string") {
      return null;
    } else {
      return await bot.sendMessage(targetId, text, extra);
    }
  } catch (e) {
    console.error("❌ safeMessageSend error:", e.message);
  }
}


bot.on("callback_query", async (query) => {
  const userId = String(query.from?.id);
  const chatId = query.message?.chat?.id;
  const inlineId = query.inline_message_id;
  const data = query.data;
  const targetId = inlineId || chatId;

  if (!userId || !targetId || !data) {
    return bot.answerCallbackQuery(query.id, { text: "❌ Xatolik yuz berdi.", show_alert: true });
  }

  const getPoll = async (pollId, errMsg = "❌ Sorovnoma tugagan yoki mavjud emas.") => {
    const poll = await Poll.findById(pollId);
    if (!poll || !poll.active) {
      await bot.answerCallbackQuery(query.id, { text: errMsg, show_alert: true });
      return null;
    }
    return poll;
  };

  try {
    if (ADMIN_ID.includes(userId) && pollSessions.has(userId)) {
      const session = pollSessions.get(userId);

      const adminActions = {
        add_option: async () => {
          await bot.answerCallbackQuery(query.id);
          return safeMessageSend(targetId, "📝 Yangi variant yuboring:");
        },
        finish_options: async () => {
          if (session.options.length < 2) {
            return bot.answerCallbackQuery(query.id, {
              text: "❌ Kamida 2 ta variant bo'lishi kerak.",
              show_alert: true,
            });
          }
          session.step = "duration";
          pollSessions.set(userId, session);
          await bot.answerCallbackQuery(query.id);
          return safeMessageSend(
            targetId,
            "⏰ Sorovnoma davomiyligi (daqiqada):\n" +
              "60 = 1 soat\n1440 = 1 kun\n2880 = 2 kun\n4320 = 3 kun\n" +
              "5760 = 4 kun\n7200 = 5 kun\n8640 = 6 kun\n10080 = 7 kun"
          );
        },
        cancel_poll: async () => {
          pollSessions.delete(userId);
          await bot.answerCallbackQuery(query.id);
          return safeMessageSend(targetId, "❌ Sorovnoma bekor qilindi.");
        },
      };

      if (adminActions[data]) return adminActions[data]();
    }

    if (data.startsWith("start_vote_")) {
      const pollId = data.split("_")[2];
      const poll = await getPoll(pollId);
      if (!poll) return;

if (!(await isUserSubscribed(userId))) {
  const buttons = CHANNEL_IDS.map((ch) => [
    { text: `📢 Kanalga obuna bo'lish`, url: `https://t.me/${ch.replace("@", "")}` },
  ]);
  buttons.push([{ text: "✅ Obuna bo'ldim", callback_data: `check_subscription_${pollId}` }]);

  await bot.answerCallbackQuery(query.id, { text: "Avval kanal(lar)ga obuna bo'ling!" });

  if (chatId) {
    return safeMessageSend(chatId, `❌ Ovoz berish uchun barcha kanallarga obuna bo'ling!`, {
      reply_markup: { inline_keyboard: buttons },
    });
  } else if (inlineId) {
    return safeMessageEdit(
      inlineId,
      query.message?.message_id,
      `❌ Ovoz berish uchun barcha kanallarga obuna bo'ling!`,
      { reply_markup: { inline_keyboard: buttons } }
    );
  }
}




      if (poll.votes?.has(userId.toString())) {
        return bot.answerCallbackQuery(query.id, { text: "❌ Siz allaqachon ovoz bergansiz.", show_alert: true });
      }

      const keyboard = poll.options.map((opt, i) => [
        { text: `${opt.text} (${opt.votes})`, callback_data: `vote_${poll._id}_${i}` },
      ]);
      keyboard.push([{ text: "🔙 Orqaga", callback_data: `back_to_poll_${pollId}` }]);

      await safeMessageEdit(
        targetId,
        query.message?.message_id,
        `📊 Sorovnoma:\n\n❓ ${poll.question}\n\n👇 Variantni tanlang:`,
        { reply_markup: { inline_keyboard: keyboard } }
      );
      return bot.answerCallbackQuery(query.id);
    }

    if (data.startsWith("check_subscription_")) {
      const pollId = data.split("_")[2];
      if (!(await isUserSubscribed(userId))) {
        return bot.answerCallbackQuery(query.id, { text: "❌ Siz hali kanalga obuna bo'lmadingiz!", show_alert: true });
      }
      const poll = await getPoll(pollId);
      if (!poll) return;

      const keyboard = poll.options.map((opt, i) => [
        { text: `${opt.text} (${opt.votes})`, callback_data: `vote_${poll._id}_${i}` },
      ]);
      keyboard.push([{ text: "🔙 Orqaga", callback_data: `back_to_poll_${pollId}` }]);

      await safeMessageEdit(
        targetId,
        query.message?.message_id,
        `📊 Sorovnoma:\n\n❓ ${poll.question}\n\n👇 Variantni tanlang:`,
        { reply_markup: { inline_keyboard: keyboard } }
      );
      return bot.answerCallbackQuery(query.id, { text: "✅ Obuna tasdiqlandi!" });
    }

    if (data.startsWith("back_to_poll_")) {
      const pollId = data.split("_")[3];
      const poll = await getPoll(pollId);
      if (!poll) return;

      await safeMessageEdit(targetId, query.message?.message_id, `📊 Sorovnoma:\n\n❓ ${poll.question}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🗳 Ovoz berish", callback_data: `start_vote_${poll._id}` }],
            [{ text: "📤 Ulashish", switch_inline_query: `poll_${poll._id}` }],
          ],
        },
      });
      return bot.answerCallbackQuery(query.id);
    }

    if (data.startsWith("vote_")) {
      const [, pollId, optionIndex] = data.split("_");
      const poll = await getPoll(pollId);
      if (!poll) return;

      if (!(await isUserSubscribed(userId))) {
        return bot.answerCallbackQuery(query.id, { text: "❌ Ovoz berish uchun obuna bo'ling!", show_alert: true });
      }
      if (poll.votes?.has(userId.toString())) {
        return bot.answerCallbackQuery(query.id, { text: "❌ Siz allaqachon ovoz bergansiz.", show_alert: true });
      }

      const optIndex = Number(optionIndex);
      poll.options[optIndex].votes++;
      poll.votes.set(userId.toString(), optIndex);
      await poll.save();

      await safeMessageEdit(
        targetId,
        query.message?.message_id,
        `📊 Sorovnoma:\n\n❓ ${poll.question}\n\n✅ Siz "${poll.options[optIndex].text}" variantiga ovoz berdingiz!`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📊 Natijalar", callback_data: `show_results_${poll._id}` }],
              [{ text: "📤 Ulashish", switch_inline_query: `poll_${poll._id}` }],
            ],
          },
        }
      );
      return bot.answerCallbackQuery(query.id, { text: "✅ Ovozingiz qabul qilindi!" });
    }

    if (data.startsWith("show_results_")) {
      const pollId = data.split("_")[2];
      const poll = await Poll.findById(pollId);
      if (!poll) {
        return bot.answerCallbackQuery(query.id, { text: "❌ Sorovnoma topilmadi.", show_alert: true });
      }

      const total = poll.options.reduce((s, o) => s + o.votes, 0);
      let resultText = `📊 Natijalar:\n\n❓ ${poll.question}\n\n`;
      poll.options.forEach((opt, i) => {
        const percent = total ? Math.round((opt.votes / total) * 100) : 0;
        const bar = "▓".repeat(percent / 5) + "░".repeat(20 - percent / 5);
        resultText += `${i + 1}. ${opt.text}\n${bar} ${opt.votes} ovoz (${percent}%)\n\n`;
      });
      resultText += `👥 Jami ovoz: ${total}\n${poll.active ? "⏳ Faol" : "🔒 Tugagan"}`;

      await safeMessageEdit(targetId, query.message?.message_id, resultText, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 Orqaga", callback_data: `back_to_poll_${pollId}` }],
            [{ text: "📤 Ulashish", switch_inline_query: `poll_${pollId}` }],
          ],
        },
      });
      return bot.answerCallbackQuery(query.id);
    }
  } catch (err) {
    console.error("❌ Callback error:", err);
    await bot.answerCallbackQuery(query.id, { text: "❌ Xatolik yuz berdi.", show_alert: true });
  }
});

async function announceResults(poll) {
  try {
    const totalVotes = poll.options.reduce((sum, opt) => sum + opt.votes, 0);
    let result = `📊 Sorovnoma yakunlandi!\n\n❓ ${poll.question}\n\n📈 Yakuniy natijalar:\n`;

    const sortedOptions = [...poll.options].sort((a, b) => b.votes - a.votes);

    sortedOptions.forEach((opt, index) => {
      const percentage = totalVotes > 0 ? Math.round((opt.votes / totalVotes) * 100) : 0;
      result += `${index + 1}. ${opt.text}: ${opt.votes} ovoz (${percentage}%)\n`;
    });

    result += `\n👥 Jami ovoz: ${totalVotes}`;

    const users = await User.find({});
    let sentCount = 0;

    for (const user of users) {
      if (ADMIN_ID.includes(String(user.userId))) {
        const sent = await safeMessageSend(user.userId, result);
        if (sent) sentCount++;
      }
    }

    await safeMessageSend(
      ADMIN_ID,
      result + `\n\n📊 Natija ${sentCount} ta foydalanuvchiga yuborildi.`
    );
  } catch (err) {
    console.error("❌ Announce results error:", err);
  }
}

bot.on("inline_query", async (query) => {
  const queryText = query.query;

  if (!queryText.startsWith("poll_")) {
    return bot.answerInlineQuery(query.id, []);
  }

  try {
    const pollId = queryText.replace("poll_", "");

    if (!mongoose.Types.ObjectId.isValid(pollId)) {
      return bot.answerInlineQuery(query.id, []);
    }

    const poll = await Poll.findById(pollId);
    if (!poll) {
      return bot.answerInlineQuery(query.id, []);
    }

    const results = [
      {
        type: "article",
        id: `poll_${poll._id}`,
        title: `📊 ${poll.question}`,
        description: poll.active
          ? "Faol so‘rovnoma - Ovoz berish uchun bosing"
          : "Tugagan so‘rovnoma",
        input_message_content: {
          message_text: `📊 So‘rovnoma:\n\n❓ ${poll.question}`,
          parse_mode: "HTML",
        },
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🗳 Ovoz berish",
                callback_data: `start_vote_${poll._id}`,
              },
            ],
            [
              {
                text: "📊 Natijalarni ko‘rish",
                callback_data: `show_results_${poll._id}`,
              },
            ],
            [
              {
                text: "📤 Ulashish",
                switch_inline_query: `poll_${poll._id}`,
              },
            ],
          ],
        },
      },
    ];

    await bot.answerInlineQuery(query.id, results, {
      cache_time: 0,
      is_personal: true,
    });
  } catch (err) {
    console.error("❌ Inline query error:", err);
    await bot.answerInlineQuery(query.id, []);
  }
});

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from?.id);

  // ❌ admin emas bo‘lsa, to‘xtatamiz
  if (!userId || !ADMIN_ID.includes(userId)) {
    return safeMessageSend(chatId, "❌ Bu buyruqni faqat admin ishlatishi mumkin.");
  }

  try {
    const totalUsers = await User.countDocuments();
    const verifiedUsers = await User.countDocuments({ emailVerified: true });
    const activePolls = await Poll.countDocuments({ active: true });
    const totalPolls = await Poll.countDocuments();
    
    const stats = `📊 Bot statistikasi:\n\n` +
      `👥 Jami foydalanuvchilar: ${totalUsers}\n` +
      `✅ Tasdiqlangan foydalanuvchilar: ${verifiedUsers}\n` +
      `📊 Faol so'rovnomalar: ${activePolls}\n` +
      `📋 Jami so'rovnomalar: ${totalPolls}\n` +
      `💾 Vaqtinchalik ma'lumotlar: ${tempData.size} ta sessiya`;

    await safeMessageSend(chatId, stats);
  } catch (err) {
    console.error("❌ Stats command error:", err);
    await safeMessageSend(chatId, "❌ Statistikani olishda xatolik yuz berdi.");
  }
});

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from?.id);
  const message = match[1];

  // ✅ faqat adminlar ishlata oladi
  if (!userId || !ADMIN_ID.includes(userId)) {
    return safeMessageSend(chatId, "❌ Bu buyruqni faqat admin ishlatishi mumkin.");
  }

  if (!message || message.trim().length === 0) {
    return safeMessageSend(
      chatId,
      "❌ Xabar matni bo'sh bo'lishi mumkin emas.\n\nMisol: /broadcast Salom hammaga!"
    );
  }

  try {
    const users = await User.find({});
    let sentCount = 0;
    let failedCount = 0;

    const broadcastMessage = `📢 Admin xabari:\n\n${message.trim()}`;

    for (const user of users) {
      const sent = await safeMessageSend(user.userId, broadcastMessage);
      if (sent) {
        sentCount++;
      } else {
        failedCount++;
      }
      await new Promise((resolve) => setTimeout(resolve, 50)); // flood limit oldini olish
    }

    await safeMessageSend(
      chatId,
      `✅ Xabar yuborish yakunlandi!\n\n` +
        `📤 Muvaffaqiyatli: ${sentCount}\n` +
        `❌ Muvaffaqiyatsiz: ${failedCount}\n` +
        `👥 Jami: ${users.length}`
    );

    console.log(`📢 Broadcast completed: ${sentCount} sent, ${failedCount} failed`);
  } catch (err) {
    console.error("❌ Broadcast command error:", err);
    await safeMessageSend(chatId, "❌ Xabar yuborishda xatolik yuz berdi.");
  }
});


bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from?.id); 

  if (!userId) return;

  const isAdmin = ADMIN_ID.includes(userId);

  let helpText = `🤖 Bot yordami:\n\n` +
    `👤 Foydalanuvchi buyruqlari:\n` +
    `/start - Ro'yxatdan o'tish\n` +
    `/help - Yordam ma'lumotlari\n\n`;

  if (isAdmin) {
    helpText += `👑 Admin buyruqlari:\n` +
      `/stats - Bot statistikasi\n` +
      `/broadcast [xabar] - Barcha foydalanuvchilarga xabar yuborish\n\n` +
      `/poll - Yangi so'rovnoma yaratish\n` +
      `/cancel_poll - So'rovnoma yaratishni bekor qilish\n` +
      `/allpoll - Barcha so'rovnomalarni ko'rish\n` + 
      `/clearpoll - Barcha so'rovnomalarni o'chirish\n\n`;
  }

  helpText += `📊 So'rovnomalar:\n` +
    `• So'rovnomalarda ovoz berish uchun kanalga obuna bo'ling\n` +
    `• Har bir so'rovnomada faqat bir marta ovoz berishingiz mumkin\n` +
    `• Natijalarni istalgan vaqtda ko'rishingiz mumkin`;

  await safeMessageSend(chatId, helpText);
});


async function cleanupExpiredData() {
  try {
    const expiredPolls = await Poll.find({
      active: true,
      expiresAt: { $lt: new Date() }
    });

    for (const poll of expiredPolls) {
      poll.active = false;
      await poll.save();
      await announceResults(poll);
    }

    if (expiredPolls.length > 0) {
      console.log(`🧹 Cleaned up ${expiredPolls.length} expired polls`);
    }

    const now = Date.now();
    let expiredCount = 0;
    
    for (const [userId, expiry] of verificationCodeExpiry.entries()) {
      if (now > expiry) {
        cleanUserData(parseInt(userId));
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      console.log(`🧹 Cleaned up ${expiredCount} expired verification codes`);
    }

  } catch (err) {
    console.error("❌ Cleanup error:", err);
  }
}

setInterval(cleanupExpiredData, 5 * 60 * 1000);

mongoose.connection.on('disconnected', () => {
  console.log('❌ MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
  console.log('✅ MongoDB reconnected');
});

process.on('SIGINT', async () => {
  console.log('🛑 Bot stopping...');
  
  try {
    await bot.stopPolling();
    console.log('✅ Bot polling stopped');
    
    await mongoose.connection.close();
    console.log('✅ MongoDB connection closed');
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Error during shutdown:', err);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  console.log('🛑 Bot terminating...');
  
  try {
    await bot.stopPolling();
    await mongoose.connection.close();
    process.exit(0);
  } catch (err) {
    console.error('❌ Error during termination:', err);
    process.exit(1);
  }
});

bot.on('polling_error', (err) => {
  console.error('❌ Polling error:', err.code, err.message);
  
  if (err.code === 'ETELEGRAM') {
    console.log('🔄 Continuing after Telegram API error...');
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise);
  console.error('❌ Reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  
  setTimeout(async () => {
    try {
      await bot.stopPolling();
      await mongoose.connection.close();
    } catch (shutdownErr) {
      console.error('❌ Error during emergency shutdown:', shutdownErr);
    }
    process.exit(1);
  }, 1000);
});

console.log('🎉 Telegram bot is fully initialized and ready!');