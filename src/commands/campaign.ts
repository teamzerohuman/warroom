import {
  checkCampaignStatusOptions,
  setCampaignStatus,
  type CampaignStatusName,
} from '../lib/campaign.js';

export type CampaignStatusOptions = {
  issue: string;
  status: CampaignStatusName;
  confirm?: boolean;
  reason?: string;
};

export function runCampaignStatusCheck() {
  return checkCampaignStatusOptions();
}

export function runCampaignStatus(options: CampaignStatusOptions) {
  return setCampaignStatus(options.issue, options.status, {
    confirm: options.confirm,
    reason: options.reason,
  });
}
