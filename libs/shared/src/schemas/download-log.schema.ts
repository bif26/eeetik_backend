import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { DownloadRequestType } from '../enums/download-request-type.enum';
import { DownloadStatus } from '../enums/download-status.enum';

@Schema({
  collection: 'download_logs',
  timestamps: true,
})
export class DownloadLog {
  @Prop({ required: true, unique: true, index: true })
  jobId!: string;

  @Prop({ required: true, index: true })
  uniqueId!: string;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(DownloadRequestType),
  })
  requestType!: DownloadRequestType;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(DownloadStatus),
    default: DownloadStatus.PROCESSING,
  })
  status!: DownloadStatus;

  @Prop()
  downloadUrl?: string;

  @Prop()
  storageKey?: string;

  @Prop({ type: Number, min: 0 })
  storageBytes?: number;

  @Prop()
  storageExpiresAt?: Date;

  @Prop()
  storageDeletedAt?: Date;

  /** Telegram CDN file identifier cached after a successful upload. */
  @Prop({ index: true })
  telegramFileId?: string;

  /** Telegram chat the processed media was delivered to (bot flow). */
  @Prop({ type: Number })
  chatId?: number;

  /** Telegram user id of the requester (bot / Mini App flow). */
  @Prop({ type: Number, index: true })
  telegramUserId?: number;

  @Prop()
  errorMessage?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export type DownloadLogDocument = HydratedDocument<DownloadLog>;
export const DownloadLogSchema = SchemaFactory.createForClass(DownloadLog);
