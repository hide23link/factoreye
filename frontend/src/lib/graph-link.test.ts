import { afterEach, describe, expect, it } from "vitest";

import type { Sensor, Widget } from "../types";
import { buildGraphLinkUrl, clearGraphLinkFromUrl, graphName, isGraphWidget, parseGraphLink } from "./graph-link";

function makeWidget(overrides: Partial<Widget> = {}): Widget {
  return {
    id: "w1",
    dashboardId: "d1",
    sensorId: "s1",
    type: "SensorGraph",
    gridColumn: 1,
    gridRow: 1,
    gridWidth: 6,
    gridHeight: 6,
    config: {},
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const sensor = { id: "s1", name: "乾燥炉 温度" } as Sensor;

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("parseGraphLink", () => {
  it("ダッシュボード・グラフ・直近の分数を読む", () => {
    expect(parseGraphLink("?dashboard=d1&graph=w1&range=180m")).toEqual({
      kind: "link",
      link: { dashboardId: "d1", graphId: "w1", rangeMinutes: 180 },
    });
  });

  it.each(["", "&range=abc", "&range=5m", "&range=10081m", "&range=1h", "&range=-30m"])(
    "range がおかしい・無いとき（%s）は、既定の 30 分にする",
    (range) => {
      const result = parseGraphLink(`?dashboard=d1&graph=w1${range}`);
      expect(result.kind === "link" && result.link.rangeMinutes).toBe(30);
    },
  );

  it("range の下限 10 分・上限 10080 分は使える", () => {
    const at = (text: string) => {
      const result = parseGraphLink(`?dashboard=d1&graph=w1&range=${text}`);
      return result.kind === "link" ? result.link.rangeMinutes : null;
    };
    expect(at("10m")).toBe(10);
    expect(at("10080m")).toBe(10080);
  });

  it("ID が両方無ければ、リンクではない（ダッシュボードの ?range=1h だけのときも）", () => {
    expect(parseGraphLink("")).toEqual({ kind: "none" });
    expect(parseGraphLink("?range=1h")).toEqual({ kind: "none" });
  });

  it("ID が片方しか無ければ、壊れたリンク（見つからない扱い）", () => {
    expect(parseGraphLink("?dashboard=d1&range=30m")).toEqual({ kind: "broken" });
    expect(parseGraphLink("?graph=w1")).toEqual({ kind: "broken" });
    expect(parseGraphLink("?dashboard=d1&graph=")).toEqual({ kind: "broken" });
  });
});

describe("buildGraphLinkUrl", () => {
  it("リンクの形 /?dashboard=…&graph=…&range=Nm で組み立てる（読み直すと同じ）", () => {
    const url = buildGraphLinkUrl("https://example.com/", "d1", "w1", 45);
    expect(url).toBe("https://example.com/?dashboard=d1&graph=w1&range=45m");
    expect(parseGraphLink(new URL(url).search)).toEqual({ kind: "link", link: { dashboardId: "d1", graphId: "w1", rangeMinutes: 45 } });
  });
});

describe("clearGraphLinkFromUrl", () => {
  it("リンクのクエリだけを消す（ほかのクエリは残す）", () => {
    window.history.replaceState(null, "", "/?dashboard=d1&graph=w1&range=30m&keep=1");
    clearGraphLinkFromUrl();
    expect(window.location.search).toBe("?keep=1");
  });
});

describe("isGraphWidget・graphName", () => {
  it("グラフの 2 種類だけを、リンクで開ける", () => {
    expect(isGraphWidget(makeWidget({ type: "SensorGraph" }))).toBe(true);
    expect(isGraphWidget(makeWidget({ type: "MultiSensorComparison" }))).toBe(true);
    expect(isGraphWidget(makeWidget({ type: "Gauge" }))).toBe(false);
  });

  it("名前は タイトル → センサーの名前 → 種類の名前 の順", () => {
    expect(graphName(makeWidget({ config: { title: "炉の温度" } }), [sensor])).toBe("炉の温度");
    expect(graphName(makeWidget(), [sensor])).toBe("乾燥炉 温度");
    expect(graphName(makeWidget({ sensorId: null }), [sensor])).toBe("グラフ");
  });
});
