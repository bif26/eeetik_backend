import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { PostType } from '../enums/post-type.enum';
import type { TikTokScrapeStats } from '../interfaces/tiktok-scrape-result.interface';

@Schema({
  collection: 'tiktok_metadata',
  timestamps: true,
})
export class TikTokMetadata {
  @Prop({ required: true, unique: true, index: true })
  uniqueId!: string;

  @Prop({ required: true, index: true })
  sourceUrl!: string;

  @Prop({ type: String, required: true, enum: Object.values(PostType) })
  postType!: PostType;

  @Prop()
  title?: string;

  @Prop()
  authorName?: string;

  @Prop()
  authorAvatarUrl?: string;

  @Prop()
  authorAvatarKey?: string;

  @Prop({ type: Object })
  stats?: TikTokScrapeStats;

  @Prop({ type: [String], default: [] })
  hashtags!: string[];

  @Prop()
  duration?: number;

  @Prop()
  thumbnailKey?: string;

  /** Original TikTok CDN thumbnail URL (used for Telegram previews). */
  @Prop()
  thumbnailUrl?: string;

  @Prop({ type: [String], default: [] })
  imageKeys!: string[];

  @Prop()
  originalVideoUrl?: string;

  @Prop()
  originalAudioUrl?: string;

  @Prop({ type: [String], default: [] })
  originalImageUrls!: string[];

  @Prop({ type: Object, required: true })
  rawMetadata!: Record<string, unknown>;
}

export type TikTokMetadataDocument = HydratedDocument<TikTokMetadata>;
export const TikTokMetadataSchema =
  SchemaFactory.createForClass(TikTokMetadata);
