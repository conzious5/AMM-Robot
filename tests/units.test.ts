import { describe, expect, it } from "vitest";
process.env.DATABASE_URL ||= "postgresql://test:test@localhost:5432/test";
import { normalizeVscoEvent } from "@/providers/vsco";
import { deterministicIntent } from "@/services/inbound";
import { nextAllowedTime, outsideQuietHours } from "@/lib/quiet-hours";
import { createOpaqueToken, sha256, verifyHmac } from "@/lib/crypto";
import { createHmac } from "node:crypto";

describe("VSCO normalization",()=>{it("preserves offset and assignments",()=>{const x=normalizeVscoEvent({id:12,name:"Wedding",start:"2026-08-12T15:00:00-06:00",timezone:"America/Denver",venue:{name:"Manor"},assignments:[{id:4,role:"Videographer",teamMember:{id:8,firstName:"A",lastName:"B",email:"a@example.com"}}]});expect(x.externalId).toBe("12");expect(x.startsAt.toISOString()).toBe("2026-08-12T21:00:00.000Z");expect(x.assignments?.[0].teamMember.id).toBe("8")});it("reports missing assignments as null",()=>expect(normalizeVscoEvent({id:"1",name:"W",start:"2026-08-12T15:00:00Z"}).assignments).toBeNull())});
describe("deterministic inbound",()=>{it.each([["CONFIRM","CONFIRM"],["yes!","CONFIRM"],["decline","DECLINE"],["STOP","STOP"],["What is next?","NATURAL_LANGUAGE"]])("%s", (text,intent)=>expect(deterministicIntent(text)).toBe(intent))});
describe("quiet hours",()=>{it("detects night and moves to 8am",()=>{const night=new Date("2026-08-12T05:00:00Z");expect(outsideQuietHours(night,"America/Denver")).toBe(false);expect(nextAllowedTime(night,"America/Denver").toISOString()).toBe("2026-08-12T14:00:00.000Z")})});
describe("tokens and signatures",()=>{it("hashes opaque tokens",()=>{const x=createOpaqueToken();expect(x.token).not.toBe(x.hash);expect(sha256(x.token)).toBe(x.hash)});it("verifies HMAC without timing leaks",()=>{const raw="payload",key="secret",sig=createHmac("sha256",key).update(raw).digest("hex");expect(verifyHmac(raw,sig,key)).toBe(true);expect(verifyHmac(raw,"bad",key)).toBe(false)})});
