import { describe, expect, it } from "vitest";
import { convert, formatMoney, fromDb, lineAmounts, parseDecimal, round, toDb, unitPrice } from "@/lib/money";

const d = (v: string) => parseDecimal(v);

describe("money", () => {
  it("parsea y rechaza entradas inválidas", () => {
    expect(toDb(d("12.5"))).toBe("12.500000");
    expect(toDb(d("1,234.5"))).toBe("1234.500000");
    for (const bad of ["-1", "1e3", "", "abc", "1.1234567", "NaN", " "]) expect(() => parseDecimal(bad)).toThrow();
  });
  it("redondea half-up sin errores de float", () => {
    expect(formatMoney(d("1.005"))).toBe("1.01");
    expect(formatMoney(d("2.675"))).toBe("2.68");
    expect(round(d("0.004"))).toBe(0n);
  });
  it("precio = costo + utilidad; IVA 13% como la cotización de referencia", () => {
    const price = unitPrice({ cost: d("15000"), costCurrency: "CRC", marginPercent: d("22.25"), currency: "CRC", fxRate: d("462.29") });
    expect(formatMoney(price)).toBe("18,337.50");
    const { subtotal, tax, total } = lineAmounts(d("1"), d("18337.58"), d("13"));
    expect([formatMoney(subtotal), formatMoney(tax), formatMoney(total)]).toEqual(["18,337.58", "2,383.89", "20,721.47"]);
  });
  it("convierte monedas con tipo de cambio de venta", () => {
    const usd = unitPrice({ cost: d("10"), costCurrency: "USD", marginPercent: d("20"), currency: "CRC", fxRate: d("462.29") });
    expect(formatMoney(usd)).toBe("5,547.48");
    const back = unitPrice({ cost: d("4622.9"), costCurrency: "CRC", marginPercent: d("10"), currency: "USD", fxRate: d("462.29") });
    expect(formatMoney(back)).toBe("11.00");
    expect(formatMoney(convert(d("20721.46"), "CRC", "USD", d("462.2900")))).toBe("44.82");
  });
  it("round-trip con NUMERIC", () => expect(toDb(fromDb("5.5"))).toBe("5.500000"));
  it("rechaza comas ambiguas y conserva precisión de la utilidad", () => {
    for (const bad of ["1,5", "0,50", "1,,2", "12,34", ",5"]) expect(() => parseDecimal(bad)).toThrow();
    expect(toDb(parseDecimal("1,234,567.5"))).toBe("1234567.500000");
    const price = unitPrice({ cost: d("10000000000"), costCurrency: "CRC", marginPercent: d("25.000001"), currency: "CRC", fxRate: d("462.29") });
    expect(formatMoney(price)).toBe("12,500,000,100.00");
  });
  it("redondea una sola vez (sin doble redondeo)", () => {
    const price = unitPrice({ cost: d("0.913636"), costCurrency: "CRC", marginPercent: d("10"), currency: "CRC", fxRate: d("462.29") });
    expect(formatMoney(price)).toBe("1.00");
  });
  it("cantidades grandes sin overflow", () => {
    const { total } = lineAmounts(d("1000000"), d("99999999.99"), d("13"));
    expect(formatMoney(total)).toBe("112,999,999,988,700.00");
  });
});
