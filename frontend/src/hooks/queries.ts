import { useQuery } from "@tanstack/react-query";

import {
  fetchAlarms,
  fetchDashboard,
  fetchDashboards,
  fetchPlugins,
  fetchSensorReadings,
  fetchSensors,
} from "../lib/api";

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

export const usePlugins = () =>
  useQuery({ queryKey: ["plugins"], queryFn: fetchPlugins, refetchInterval: POLL_INTERVAL_MS });

export const useSensorReadings = (sensorId: string | null, hours = 1) =>
  useQuery({
    queryKey: ["readings", sensorId, hours],
    queryFn: () => {
      const from = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      return fetchSensorReadings(sensorId as string, from);
    },
    enabled: sensorId !== null,
    refetchInterval: POLL_INTERVAL_MS,
  });
