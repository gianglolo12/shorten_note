require('dotenv').config();
const { Telegraf } = require('telegraf');
const { google } = require('googleapis');

const express = require('express');
const fs = require('fs');
const path = require('path');

// Configurations
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const app = express();
const PORT = process.env.PORT || 3000;

// Google OAuth Setup
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ||
  'https://shortnote-e24845a632b3.herokuapp.com/oauth2callback';

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

const userTokens = {};

const defaultEvent = {
  summary: 'Sample Event',
  location: '',
  description: 'This is a sample event.',
  start: {
    dateTime: '2024-11-11T10:00:00+07:00',
    timeZone: 'Asia/Ho_Chi_Minh',
  },
  end: {
    dateTime: '2024-11-11T11:00:00+07:00',
    timeZone: 'Asia/Ho_Chi_Minh',
  },
  enventType: 'focusTime',
};

// Load existing tokens from db.json if it exists
const dbPath = path.join(__dirname, 'db.json');
if (fs.existsSync(dbPath)) {
  const data = fs.readFileSync(dbPath, 'utf8');
  Object.assign(userTokens, JSON.parse(data));
}

const isTokenExpired = async (tokens) => {
  oauth2Client.setCredentials(tokens);
  try {
    await oauth2Client.getAccessToken();
    return false; // Token is still valid
  } catch (error) {
    if (error.message.includes('No refresh token')) {
      return true; // Token is expired
    }
    throw error; // Some other error occurred
  }
};

const addEvent = async (ctx, body) => {
  const telegramId = ctx.from.id;
  const tokens = userTokens[telegramId];
  const isExpired = await isTokenExpired(tokens);
  if (isExpired) {
    delete userTokens[telegramId];
    fs.writeFileSync(dbPath, JSON.stringify(userTokens, null, 2));
    await callGooglelogin(ctx);
    return;
  }

  oauth2Client.setCredentials(tokens);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  try {
    const r = await calendar.events.insert({
      calendarId: 'primary',
      resource: {
        ...body,
        visibility: 'private',
      },
    });
    return {
      url: r.data.htmlLink,
      summary: r.data.summary.slice(0, 15).concat('...'),
    };
  } catch (error) {
    console.error('Error creating event', error);
    ctx.reply('There was an error creating the event.');
  }
};

const callGooglelogin = async (ctx) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state: JSON.stringify({ telegramId: ctx.from.id }),
  });

  await ctx.reply('You must login to use this function', {
    reply_markup: {
      inline_keyboard: [{ text: 'Authenticate', url }],
    },
  });
};

const botInit = () => {
  bot.on('message', async (ctx) => {
    if (ctx.message.text.startsWith('/')) {
      return; // Ignore commands
    }

    if (!!userTokens[ctx.from.id]) {
      const message = ctx.message.text;

      const obj = message.split('\n').reduce((acc, curr, index) => {
        const datePatternGlobal = /\b(\d{2}\/\d{2})\b/;
        const matches = curr.match(datePatternGlobal);

        if (!!matches?.length) {
          acc = { ...acc, [matches[1]]: curr };
        } else {
          acc = { ...acc, [`noneOf${index}`]: curr };
        }
        return acc;
      }, {});

      const promises = [];
      const orther = [];

      for (const key in obj) {
        if (!!key && !key.startsWith('noneOf')) {
          const date = key.split('/');
          let year = new Date().getFullYear();
          const month = date[1] - 1;
          const day = date[0];

          const currentMonth = new Date().getMonth() + 1;
          if (month > currentMonth) {
            year = year + 1;
          }

          const start = new Date(Date.UTC(year, month, day, 0, 0, 0));
          const end = new Date(Date.UTC(year, month, day, 23, 59, 59));

          const event = {
            ...defaultEvent,
            summary: obj[key],
            description: obj[key],
            start: {
              dateTime: new Date(start).toISOString().split('.')[0] + 'Z',
              timeZone: 'Asia/Ho_Chi_Minh',
            },
            end: {
              dateTime: new Date(end).toISOString().split('.')[0] + 'Z',
              timeZone: 'Asia/Ho_Chi_Minh',
            },
          };
          promises.push(addEvent(ctx, event));
        } else if (!!obj[key]) orther.push(obj[key]);
      }

      const chat = await bot.telegram.sendMessage(ctx.from.id, 'Processing...');
      const chatId = chat.message_id;

      var completed = 0;
      const total = promises.length;
      const successTitle = total > 0 ? `Event successfully created \n` : '';
      let addedGroup = '',
        ortherGroups = '';
      const divider =
        total > 0 && !!orther.length
          ? '------------------------------------\n'
          : '';
      const ortherTitle = !!orther.length ? `Orthers note \n \n` : '';

      orther.forEach((r) => {
        ortherGroups += `🗒 ${r} \n`;
      });

      for (let i = 0; i < promises.length; i++) {
        try {
          const r = await promises[i];
          completed++;
          addedGroup += `✅ ${r.summary} <a href="${r.url}">View</a> \n`;
          const percentage = Math.round((completed / total) * 100);
          const progressBar =
            '█'.repeat(percentage / 10) + '░'.repeat(10 - percentage / 10);

          await bot.telegram.editMessageText(
            ctx.from.id,
            chatId,
            null,
            `Processing...\n[${progressBar}] ${percentage}%`
          );
        } catch (error) {
          console.error('Error processing promise', error);
        }
      }

      if (!total && !orther.length) return;

      if (completed === total)
        bot.telegram.editMessageText(
          ctx.from.id,
          chatId,
          null,
          `${successTitle} <blockquote>${addedGroup}</blockquote> ${divider} ${ortherTitle} <blockquote>${ortherGroups}</blockquote>`,
          {
            parse_mode: 'HTML',
          }
        );
    } else {
      await callGooglelogin(ctx);
    }
  });

  bot.launch();
};

app.get('/oauth2callback', async (req, res) => {
  const { code, state } = req.query;
  const { telegramId } = JSON.parse(state);
  try {
    const { tokens } = await oauth2Client.getToken(code);
    // Save token to local file
    userTokens[telegramId] = tokens;
    fs.writeFileSync(dbPath, JSON.stringify(userTokens, null, 2));
    res.send(
      'Login successful! You can now create calendar events with the bot.'
    );
    bot.telegram.sendMessage(
      telegramId,
      'Login successful! You can now create calendar events with the bot.'
    );
  } catch (error) {
    console.error('Error retrieving access token', error);
    res.status(500).send('Authentication failed');
  }
});

const deleteAllEvents = async (ctx) => {
  const telegramId = ctx.from.id;
  const tokens = userTokens[telegramId];
  const isExpired = await isTokenExpired(tokens);
  if (isExpired) {
    delete userTokens[telegramId];
    fs.writeFileSync(dbPath, JSON.stringify(userTokens, null, 2));
    await callGooglelogin(ctx);
    return;
  }

  ctx.reply('Deleting all events...');

  oauth2Client.setCredentials(tokens);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  try {
    const events = await calendar.events.list({
      calendarId: 'primary',
    });
    const deletePromises = events.data.items.map((event) =>
      calendar.events.delete({
        calendarId: 'primary',
        eventId: event.id,
      })
    );

    await Promise.all(deletePromises);
    ctx.reply('All events have been deleted.');
  } catch (error) {
    console.error('Error deleting events', error);
    ctx.reply('There was an error deleting the events.');
  }
};

const onStart = (ctx) => {
  if (!!userTokens[ctx.from.id]) ctx.reply('Welcome to the Calendar Bot!');
  else callGooglelogin(ctx);
};

bot.command('start', onStart);
bot.command('deleteallevents', deleteAllEvents);

app.get('/', (req, res) => {
  res.send('Telegram bot is running');
});

app.listen(PORT, () => console.log(`App listening on port ${PORT}`));
botInit();
