import { describe, expect, it } from "vitest";
process.env.DATABASE_URL ||= "postgresql://test:test@localhost:5432/test";
import { isProductionAssignment, isTimelineFile, normalizeVscoEvent } from "@/providers/vsco";
import { deterministicIntent, isFinancialQuestion, requestedEventDate, selectRequestedAssignment, standardPayReply } from "@/services/inbound";
import { nextAllowedTime, outsideQuietHours } from "@/lib/quiet-hours";
import { createOpaqueToken, sha256, verifyHmac, verifyQuoWebhook } from "@/lib/crypto";
import { createHmac } from "node:crypto";
import { reminderStepIsSatisfied } from "@/lib/reminders";
import { plainStatus } from "@/services/operation-status";
import { brandedEmailHtml } from "@/services/messaging";

describe("VSCO normalization",()=>{it("preserves offset and assignments",()=>{const x=normalizeVscoEvent({id:12,name:"Wedding",start:"2026-08-12T15:00:00-06:00",timezone:"America/Denver",venue:{name:"Manor"},assignments:[{id:4,role:"Videographer",teamMember:{id:8,firstName:"A",lastName:"B",email:"a@example.com"}}]});expect(x.externalId).toBe("12");expect(x.startsAt.toISOString()).toBe("2026-08-12T21:00:00.000Z");expect(x.assignments?.[0].teamMember.id).toBe("8")});it("reports missing assignments as null",()=>expect(normalizeVscoEvent({id:"1",name:"W",start:"2026-08-12T15:00:00Z"}).assignments).toBeNull())});
describe("booked gig detection",()=>{it.each(["Photographer","Lead Photographer","Videographer","Video"])("%s is production",role=>expect(isProductionAssignment({role,teamMember:{firstName:"A",lastName:"B"}})).toBe(true));it.each(["Sales","Planner","Partner 1 Prep","Client"])("%s is not production",role=>expect(isProductionAssignment({role,teamMember:{firstName:"A",lastName:"B"}})).toBe(false))});
describe("deterministic inbound",()=>{it.each([["CONFIRM","CONFIRM"],["yes!","CONFIRM"],["decline","DECLINE"],["STOP","STOP"],["MENU","HELP"],["show my assignment details","DETAILS"],["send the timeline","TIMELINE"],["job day sheet","TIMELINE"],["what ceremonies are upcoming?","SCHEDULE"],["where is my venue?","LOCATION"],["what time does it start?","HOURS"],["What is my rate?","PAY"],["PAY","PAY"],["show my invoice","FINANCIAL"],["What is next?","NATURAL_LANGUAGE"]])("%s", (text,intent)=>expect(deterministicIntent(text)).toBe(intent));it("blocks nonstandard financial questions",()=>{expect(isFinancialQuestion("When do I get paid?")).toBe(true);expect(isFinancialQuestion("Where is my ceremony?")).toBe(false)});it("calculates mileage from total trip miles",()=>{expect(standardPayReply("What is travel pay for 400 miles?")).toContain("$190.40");expect(standardPayReply("100 miles")).toContain("$0.00")})});
describe("date-specific inbound assignment selection", () => {
  const assignments = [
    { id: "aug-14", event: { startsAt: new Date("2026-08-14T21:30:00.000Z"), timezone: "America/Denver" } },
    { id: "aug-29", event: { startsAt: new Date("2026-08-29T22:30:00.000Z"), timezone: "America/Denver" } },
  ];

  it("parses named and numeric event dates", () => {
    expect(requestedEventDate("timeline for August 14th")).toEqual({ month: 8, day: 14, year: undefined });
    expect(requestedEventDate("details for 8/29/26")).toEqual({ month: 8, day: 29, year: 2026 });
  });

  it("selects the assignment named in the contractor's message", () => {
    expect(selectRequestedAssignment(assignments, "For August 29th send the timeline")?.id).toBe("aug-29");
    expect(selectRequestedAssignment(assignments, "timeline")?.id).toBe("aug-14");
  });

  it("does not silently fall back when a requested date has no assignment", () => {
    expect(selectRequestedAssignment(assignments, "timeline for August 20th")).toBeNull();
  });
});
describe("timeline files",()=>{it("allows timeline and day-sheet documents with URLs",()=>{expect(isTimelineFile({filename:"wedding-timeline.pdf",mimeType:"application/pdf",url:"https://files.example/timeline"})).toBe(true);expect(isTimelineFile({name:"Job Day Sheet",mimeType:"image/png",url:"https://files.example/day-sheet"})).toBe(true)});it("does not expose arbitrary miscellaneous or executable files",()=>{expect(isTimelineFile({description:"Miscellaneous Files",filename:"contract.pdf",mimeType:"application/pdf",url:"https://files.example/contract"})).toBe(false);expect(isTimelineFile({filename:"timeline.exe",mimeType:"application/octet-stream",url:"https://files.example/timeline"})).toBe(false)})});
describe("plain operation status",()=>{it("uses clear success and error labels",()=>{expect(plainStatus("SUCCEEDED")).toMatchObject({tone:"good",icon:"✓",label:"Worked"});expect(plainStatus("FAILED")).toMatchObject({tone:"error",icon:"×",label:"Error"});expect(plainStatus("SUPPRESSED")).toMatchObject({tone:"neutral",label:"Safely skipped"})});it("makes unknown technical statuses readable",()=>expect(plainStatus("WAITING_FOR_REVIEW")).toMatchObject({tone:"neutral",label:"waiting for review"}))});
describe("quiet hours",()=>{it("detects night and moves to 8am",()=>{const night=new Date("2026-08-12T05:00:00Z");expect(outsideQuietHours(night,"America/Denver")).toBe(false);expect(nextAllowedTime(night,"America/Denver").toISOString()).toBe("2026-08-12T14:00:00.000Z")})});
describe("sequential reminders",()=>{it("advances after completed or administrator-skipped steps",()=>{expect(reminderStepIsSatisfied({status:"COMPLETED",lastError:null})).toBe(true);expect(reminderStepIsSatisfied({status:"CANCELED",lastError:"Skipped by administrator"})).toBe(true)});it("does not advance past waiting or failed steps",()=>{expect(reminderStepIsSatisfied({status:"CANCELED",lastError:"Waiting for previous reminder outcome"})).toBe(false);expect(reminderStepIsSatisfied({status:"FAILED",lastError:"Provider unavailable"})).toBe(false)})});
describe("branded email links",()=>{it("makes confirmation URLs clickable inside multi-assignment email bodies",()=>{const html=brandedEmailHtml({preheader:"Confirm",title:"Please confirm",body:"Assignment one: https://example.com/confirm/token-one\nAssignment two: https://example.com/confirm/token-two"});expect(html).toContain('<a href="https://example.com/confirm/token-one"');expect(html).toContain('<a href="https://example.com/confirm/token-two"')})});
describe("tokens and signatures",()=>{it("hashes opaque tokens",()=>{const x=createOpaqueToken();expect(x.token).not.toBe(x.hash);expect(sha256(x.token)).toBe(x.hash)});it("verifies HMAC without timing leaks",()=>{const raw="payload",key="secret",sig=createHmac("sha256",key).update(raw).digest("hex");expect(verifyHmac(raw,sig,key)).toBe(true);expect(verifyHmac(raw,"bad",key)).toBe(false)});it("verifies Quo's structured base64 signature and rejects replays",()=>{const now=Date.now(),timestamp=String(now),raw='{\n  "id": "EV1", "type": "message.received"\n}',compact=JSON.stringify(JSON.parse(raw)),key=Buffer.from("quo-secret").toString("base64"),digest=createHmac("sha256",Buffer.from(key,"base64")).update(`${timestamp}.${compact}`).digest("base64"),header=`hmac;1;${timestamp};${digest}`;expect(verifyQuoWebhook(raw,header,key,now)).toBe(true);expect(verifyQuoWebhook(raw,header,key,now+6*60*1000)).toBe(false)})});
