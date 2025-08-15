interface TelegramMessage {
  chat_id: string;
  text: string;
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2';
}

interface TelegramResponse {
  ok: boolean;
  result?: any;
  error_code?: number;
  description?: string;
}

export class TelegramBot {
  private chatId: string;
  private baseUrl: string;

  constructor(botToken: string, chatId: string) {
    this.chatId = chatId;
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  async sendMessage(text: string, parseMode: 'HTML' | 'Markdown' | 'MarkdownV2' = 'HTML'): Promise<boolean> {
    try {
      const message: TelegramMessage = {
        chat_id: this.chatId,
        text,
        parse_mode: parseMode,
      };

      const response = await fetch(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      });

      const result: TelegramResponse = await response.json();

      if (!result.ok) {
        console.error('Telegram API error:', result.description);
        return false;
      }

      return true;
    } catch (error) {
      console.error('Error sending Telegram message:', error);
      return false;
    }
  }

  async sendError(error: Error | string, context?: string): Promise<boolean> {
    const errorMessage = error instanceof Error ? error.message : error;
    const text = `🚨 <b>Error in Plex Scrobble</b>\n\n` +
      `<b>Context:</b> ${context || 'Unknown'}\n` +
      `<b>Error:</b> <code>${errorMessage}</code>\n` +
      `<b>Time:</b> ${new Date().toISOString()}`;

    return this.sendMessage(text);
  }

  async sendWebhookSuccess(eventType: string, filmTitle?: string, rating?: number): Promise<boolean> {
    let text = `✅ <b>Webhook Success</b>\n\n` +
      `<b>Event:</b> ${eventType}\n`;

    if (filmTitle) {
      text += `<b>Film:</b> ${filmTitle}\n`;
    }

    if (rating !== undefined) {
      text += `<b>Rating:</b> ${rating}/10\n`;
    }

    text += `<b>Time:</b> ${new Date().toISOString()}`;

    return this.sendMessage(text);
  }

  async sendWebhookFailure(eventType: string, filmTitle?: string, error?: string): Promise<boolean> {
    let text = `❌ <b>Webhook Failed</b>\n\n` +
      `<b>Event:</b> ${eventType}\n`;

    if (filmTitle) {
      text += `<b>Film:</b> ${filmTitle}\n`;
    }

    if (error) {
      text += `<b>Error:</b> <code>${error}</code>\n`;
    }

    text += `<b>Time:</b> ${new Date().toISOString()}`;

    return this.sendMessage(text);
  }
}

export function createTelegramBot(): TelegramBot | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.warn('Telegram bot not configured - missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    return null;
  }

  return new TelegramBot(botToken, chatId);
}