import { describe, expect, it } from "vitest";
import { ar } from "@/i18n/resources/ar";
import { en } from "@/i18n/resources/en";
import { es } from "@/i18n/resources/es";
import { fr } from "@/i18n/resources/fr";
import { ja } from "@/i18n/resources/ja";
import { ko } from "@/i18n/resources/ko";
import { ptBR } from "@/i18n/resources/pt-BR";
import { ru } from "@/i18n/resources/ru";
import { zhCN } from "@/i18n/resources/zh-CN";

describe("Animate workspace moves help", () => {
  // The feature has no example images, so no locale may describe any.
  it.each([
    ["ar", ar],
    ["en", en],
    ["es", es],
    ["fr", fr],
    ["ja", ja],
    ["ko", ko],
    ["pt-BR", ptBR],
    ["ru", ru],
    ["zh-CN", zhCN],
  ])("%s has no caption for removed position images", (_locale, resources) => {
    expect(resources.paseoPlusPlus.examples).not.toHaveProperty("positions");
  });
});
