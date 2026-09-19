import { useMemo, useState } from "react";
import {
  buildShareCardData,
  type ShareCardData,
  type ShareCardModel,
  type ShareCardPeriod,
} from "./build-share-card-data";

interface UseShareCardDataParams {
  enabled: boolean;
  handle: string;
  startDate: string | null;
  activeDays: number;
  summary: any;
  topModels: ShareCardModel[] | null | undefined;
  period: ShareCardPeriod;
  periodFrom: string | null;
  periodTo: string | null;
  heatmap: any;
  accessToken: string | null;
  userId: string | null;
  currency?: string;
  exchangeRate?: number;
}

export function useShareCardData(params: UseShareCardDataParams): ShareCardData {
  const {
    enabled,
    handle,
    startDate,
    activeDays,
    summary,
    topModels,
    period,
    periodFrom,
    periodTo,
    heatmap,
    accessToken,
    userId,
    currency,
    exchangeRate,
  } = params;

  const [rank] = useState<number | null>(null);
  const rate = exchangeRate;

  // Leaderboard pruned in this fork: share cards no longer show a global rank.

  return useMemo(
    () =>
      buildShareCardData({
        handle,
        startDate,
        activeDays,
        summary,
        topModels,
        rank,
        period,
        periodFrom,
        periodTo,
        heatmap,
        currency,
        exchangeRate: typeof rate === "number" ? rate : undefined,
      }),
    [
      handle,
      startDate,
      activeDays,
      summary,
      topModels,
      rank,
      period,
      periodFrom,
      periodTo,
      heatmap,
      currency,
      rate,
    ],
  );
}
