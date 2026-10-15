import { DownloadRequestType } from '../enums/download-request-type.enum';

export interface PrepareDownloadJobData {
  uniqueId: string;
  requestType: DownloadRequestType;
  /** Telegram chat that should receive the processed media (bot flow). */
  chatId?: number;
  /** Telegram user id of the requester, persisted for download history. */
  telegramUserId?: number;
}
