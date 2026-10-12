import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'users',
  timestamps: true,
})
export class User {
  @Prop({ required: true, unique: true, index: true })
  telegramId!: number;

  @Prop()
  username?: string;

  @Prop()
  firstName?: string;

  @Prop()
  lastName?: string;

  @Prop()
  photoUrl?: string;

  @Prop({ type: Boolean, default: false })
  isPremium?: boolean;

  @Prop({ type: String })
  languageCode?: string;

  /**
   * Free-form Mini App preferences, e.g.:
   * { defaultQuality: 'hd' | 'sd' | 'audio' | 'zip',
   *   notifications: boolean, autoSendToChat: boolean }
   */
  @Prop({ type: Object, default: {} })
  settings?: Record<string, unknown>;

  createdAt?: Date;
  updatedAt?: Date;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);
