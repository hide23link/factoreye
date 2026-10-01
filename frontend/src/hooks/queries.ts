import { useQuery } from "@tanstack/react-query";

import {
  fetchAlarms,
  fetchDashboard,
  fetchDashboards,
  fetchSensorReadings,
  fetchSensors,
} from "../lib/api";
import type { WidgetConfig } from "../types";

const POLL_INTERVAL_MS = 5000;

export const useSensors = () =>
  useQuery({ queryKey: ["sensors"], queryFn: fetchSensors, refetchInterval: POLL_INTERVAL_MS });

export const useDashboards = () =>
  useQuery({ queryKey: ["dashboards"], queryFn: fetchDashboards });

export const useDashboard = (id: string | null) =>
  useQuery({
    queryKey: ["dashboard", id],
    queryFn: () => fetchDashboard(id as string),
    enabled: id !== null,
    refetchInterval: POLL_INTERVAL_MS,
  });

export const useAlarms = (status?: string) =>
  useQuery({
    queryKey: ["alarms", status ?? "all"],
    queryFn: () => fetchAlarms(status),
    refetchInterval: POLL_INTERVAL_MS,
  });

const RANGE_MS: Record<NonNullable<WidgetConfig["timeRange"]>, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export const useSensorReadings = (
  sensorId: string | null,
  timeRange: WidgetConfig["timeRange"] = "1h",
) =>
  useQuery({
    queryKey: ["readings", sensorId, timeRange],
    queryFn: () => {
      const from = new Date(Date.now() - RANGE_MS[timeRange]).toISOString();
      return fetchSensorReadings(sensorId as string, from);
    },
    enabled: sensorId !== null,
    refetchInterval: POLL_INTERVAL_MS,
  });
