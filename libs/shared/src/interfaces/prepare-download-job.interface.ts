import { DownloadRequestType } from '../enums/download-request-type.enum';

export interface PrepareDownloadJobData {
  uniqueId: string;
  requestType: DownloadRequestType;
}
