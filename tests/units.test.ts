import { describe, expect, it } from "vitest";
process.env.DATABASE_URL ||= "postgresql://test:test@localhost:5432/test";
import { isProductionAssignment, isTimelineFile, isWedgewoodContact, normalizeVscoEvent, vscoJobPresentation } from "@/providers/vsco";
import { deterministicIntent, explicitlyInvokesRobot, inboundAutomationText, isFinancialQuestion, requestedEventDate, selectRequestedAssignment, standardPayReply } from "@/services/inbound";
import { nextAllowedTime, outsideQuietHours } from "@/lib/quiet-hours";
import { createOpaqueToken, sha256, verifyHmac, verifyQuoWebhook } from "@/lib/crypto";
import { createHmac } from "node:crypto";
import { reminderStepIsSatisfied } from "@/lib/reminders";
import { plainStatus } from "@/services/operation-status";
import { brandedEmailHtml, withAmmRobotSignoff } from "@/services/messaging";
import { humanConversationOwnsReply, quoOutboundWasHuman } from "@/services/quo-context";
import { isActiveInboundContractor } from "@/lib/inbound-identity";
import { renderGroundedScheduleReply, safeScheduleRange } from "@/services/agent";
import { readLimitedText, RequestBodyTooLargeError } from "@/lib/http-security";
import { recentOperationsAgentResult } from "@/lib/operations-agent-result";
import { parseQuoInboundMessage } from "@/lib/quo-webhook";
import { eventTitleDate, eventTitleDateMismatch, eventWasMissingFromSuccessfulVscoScan } from "@/lib/event-date-consistency";

describe("VSCO normalization",()=>{it("preserves offset and assignments",()=>{const x=normalizeVscoEvent({id:12,name:"Wedding",start:"2026-08-12T15:00:00-06:00",timezone:"America/Denver",venue:{name:"Manor"},assignments:[{id:4,role:"Videographer",teamMember:{id:8,firstName:"A",lastName:"B",email:"a@example.com"}}]});expect(x.externalId).toBe("12");expect(x.startsAt.toISOString()).toBe("2026-08-12T21:00:00.000Z");expect(x.assignments?.[0].teamMember.id).toBe("8")});it("reports missing assignments as null",()=>expect(normalizeVscoEvent({id:"1",name:"W",start:"2026-08-12T15:00:00Z"}).assignments).toBeNull())});
describe("VSCO project presentation", () => {
  it("uses the exact VSCO job title and manager link", () => {
    expect(vscoJobPresentation({
      id: "job-1",
      title: "Taylor Smith and Morgan Lee's Photography on Saturday, September 19th, 2026",
      links: { self: { managerHref: "https://workspace.vsco.co/jobs/view/123456" } },
    })).toEqual({
      title: "Taylor Smith and Morgan Lee's Photography on Saturday, September 19th, 2026",
      administrativeUrl: "https://workspace.vsco.co/jobs/view/123456",
    });
  });
});
describe("VSCO event date safety", () => {
  it("detects a job-title date that conflicts with the ceremony calendar", () => {
    const name = "John Pham and Jordan Super-Hill's Wedgewood Video & Photo on Saturday, September 19th, 2026";
    expect(eventTitleDate(name)).toEqual({ month: 9, day: 19, year: 2026 });
    expect(eventTitleDateMismatch(name, new Date("2026-09-12T19:00:00.000Z"), "America/Denver")).toBe(true);
    expect(eventTitleDateMismatch(name, new Date("2026-09-19T19:00:00.000Z"), "America/Denver")).toBe(false);
  });

  it("does not block ordinary titles that contain no explicit date", () => {
    expect(eventTitleDateMismatch("Wedding Ceremony", new Date("2026-09-12T19:00:00.000Z"), "America/Denver")).toBe(false);
  });

  it("archives only unseen VSCO events inside a completed scan window", () => {
    const from = new Date("2026-08-01T00:00:00.000Z");
    const to = new Date("2027-08-01T00:00:00.000Z");
    const event = { vscoEventId: "event-1", startsAt: new Date("2026-09-12T19:00:00.000Z"), canceled: false };
    expect(eventWasMissingFromSuccessfulVscoScan(event, new Set(), from, to)).toBe(true);
    expect(eventWasMissingFromSuccessfulVscoScan(event, new Set(["event-1"]), from, to)).toBe(false);
    expect(eventWasMissingFromSuccessfulVscoScan({ ...event, canceled: true }, new Set(), from, to)).toBe(false);
  });
});
describe("Wedgewood directory detection", () => {
  it("recognizes Wedgewood email and organization data", () => {
    expect(isWedgewoodContact({ email: "planner@wedgewoodweddings.com" })).toBe(true);
    expect(isWedgewoodContact({ companyName: "Wedgewood Weddings" })).toBe(true);
    expect(isWedgewoodContact({ email: "other@example.com" })).toBe(false);
  });
});
describe("Quo inbound webhook parsing", () => {
  it("parses the documented API envelope", () => {
    expect(parseQuoInboundMessage({ id: "EV1", data: { object: { id: "MSG1", from: "+13035550100", to: ["+13035550101"], text: "HOURS" } } })).toMatchObject({ id: "MSG1", sender: "+13035550100", recipient: "+13035550101", text: "HOURS" });
  });
  it("parses app-webhook body fields and nested senders", () => {
    expect(parseQuoInboundMessage({ data: { message: { id: "MSG2", sender: { phoneNumber: "+13035550100" }, to: "+13035550101", body: "HELP" } } })).toMatchObject({ id: "MSG2", sender: "+13035550100", text: "HELP" });
  });
  it("safely ignores media-only updates without sender or text", () => {
    expect(parseQuoInboundMessage({ id: "EV3", data: { object: { id: "MSG3", media: [{ type: "image/jpeg" }] } } })).toBeNull();
  });
});
describe("booked gig detection",()=>{it.each(["Photographer","Lead Photographer","Videographer","Video"])("%s is production",role=>expect(isProductionAssignment({role,teamMember:{firstName:"A",lastName:"B"}})).toBe(true));it.each(["Sales","Planner","Partner 1 Prep","Client"])("%s is not production",role=>expect(isProductionAssignment({role,teamMember:{firstName:"A",lastName:"B"}})).toBe(false))});
describe("deterministic inbound",()=>{it.each([["CONFIRM","CONFIRM"],["yes!","CONFIRM"],["decline","DECLINE"],["STOP","STOP"],["MENU","HELP"],["show my assignment details","DETAILS"],["send the timeline","TIMELINE"],["job day sheet","TIMELINE"],["what ceremonies are upcoming?","SCHEDULE"],["where is my venue?","LOCATION"],["what time does it start?","HOURS"],["What is my rate?","PAY"],["PAY","PAY"],["show my invoice","FINANCIAL"],["What is next?","NATURAL_LANGUAGE"]])("%s", (text,intent)=>expect(deterministicIntent(text)).toBe(intent));it("blocks nonstandard financial questions",()=>{expect(isFinancialQuestion("When do I get paid?")).toBe(true);expect(isFinancialQuestion("Where is my ceremony?")).toBe(false)});it("calculates mileage from total trip miles",()=>{expect(standardPayReply("What is travel pay for 400 miles?")).toContain("$190.40");expect(standardPayReply("100 miles")).toContain("$0.00")})});
describe("shared Quo line automation boundary", () => {
  it.each([
    "Hey Chris, can you upload that file?",
    "I am unavailable this afternoon",
    "Where did you leave the camera?",
    "Details about the invoice we discussed",
    "CONFIRM 8/29",
  ])("leaves ordinary company text for a person: %s", text => {
    expect(inboundAutomationText(text)).toBeNull();
  });

  it.each([
    ["STOP", "STOP"],
    ["HELP?", "HELP"],
    ["DETAILS 8/29", "DETAILS 8/29"],
    ["TIMELINE August 29", "TIMELINE August 29"],
    ["ROBOT: what time is the August 29 wedding?", "what time is the August 29 wedding?"],
    ["AMM ROBOT, show my upcoming ceremonies", "show my upcoming ceremonies"],
  ])("recognizes an explicit robot request: %s", (text, expected) => {
    expect(inboundAutomationText(text)).toBe(expected);
  });
});
describe("shared Quo conversation context", () => {
  it("leaves a command-like reply with the person who sent the last outbound text", () => {
    expect(humanConversationOwnsReply({ automationText: "CONFIRM", explicitlyInvokedRobot: false, lastOutboundWasHuman: true })).toBe(true);
  });
  it("allows STOP and START regardless of human conversation context", () => {
    expect(humanConversationOwnsReply({ automationText: "STOP", explicitlyInvokedRobot: false, lastOutboundWasHuman: true })).toBe(false);
    expect(humanConversationOwnsReply({ automationText: "START", explicitlyInvokedRobot: false, lastOutboundWasHuman: true })).toBe(false);
  });
  it("allows an explicit ROBOT request to hand the conversation to automation", () => {
    expect(explicitlyInvokesRobot("ROBOT: details for August 29")).toBe(true);
    expect(humanConversationOwnsReply({ automationText: "details for August 29", explicitlyInvokedRobot: true, lastOutboundWasHuman: true })).toBe(false);
  });
  it("recognizes tracked robot messages and signed robot messages during webhook races", () => {
    expect(quoOutboundWasHuman("REMINDER_SYSTEM", "Please confirm")).toBe(false);
    expect(quoOutboundWasHuman(null, "Here are your details.\n\nSent by AMM Robot")).toBe(false);
    expect(quoOutboundWasHuman(null, "Can you confirm you received this?")).toBe(true);
  });
});
describe("AMM Robot signoff", () => {
  it("adds the signoff exactly once", () => {
    expect(withAmmRobotSignoff("Here are your details.")).toBe("Here are your details.\n\nSent by AMM Robot");
    expect(withAmmRobotSignoff("Here are your details.\n\nSent by AMM Robot")).toBe("Here are your details.\n\nSent by AMM Robot");
  });
});
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
describe("inbound contractor identity gate", () => {
  it.each(["PHOTOGRAPHER", "VIDEOGRAPHER", "BOTH"] as const)(
    "allows an active %s profile",
    role => {
      expect(isActiveInboundContractor({ role, active: true, paused: false })).toBe(true);
    },
  );

  it("rejects inactive and paused profiles before any assistant work", () => {
    expect(isActiveInboundContractor({
      role: "PHOTOGRAPHER",
      active: false,
      paused: false,
    })).toBe(false);
    expect(isActiveInboundContractor({
      role: "VIDEOGRAPHER",
      active: true,
      paused: true,
    })).toBe(false);
  });
});
describe("grounded schedule answers", () => {
  it("renders only assignment fields returned by the database", () => {
    const reply = renderGroundedScheduleReply([{
      id: "assignment-1",
      role: "VIDEOGRAPHER",
      confirmationStatus: "PENDING",
      event: {
        name: "Wedding Ceremony",
        startsAt: new Date("2026-08-14T21:30:00.000Z"),
        endsAt: null,
        timezone: "America/Denver",
        venueName: "The Pines",
        address: "633 Park Avenue",
      },
    }]);
    expect(reply).toBe("Wedding Ceremony — Aug 14, 2026 at 3:30 PM MDT; videographer; pending; The Pines, 633 Park Avenue.");
  });

  it("states when a location is absent instead of inventing one", () => {
    const reply = renderGroundedScheduleReply([{
      id: "assignment-1",
      role: "PHOTOGRAPHER",
      confirmationStatus: "CONFIRMED",
      event: {
        name: "Wedding Ceremony",
        startsAt: new Date("2026-09-01T16:00:00.000Z"),
        endsAt: null,
        timezone: "America/Denver",
        venueName: null,
        address: null,
      },
    }]);
    expect(reply).toContain("location not recorded");
  });

  it("fails closed for invalid, reversed, or past date ranges", () => {
    const now = new Date("2026-07-30T18:00:00.000Z");
    expect(safeScheduleRange({ start: "not-a-date", end: "2026-08-01" }, now)).toBeNull();
    expect(safeScheduleRange({ start: "2026-08-02", end: "2026-08-01" }, now)).toBeNull();
    expect(safeScheduleRange({ start: "2026-07-01", end: "2026-07-02" }, now)).toBeNull();
  });
});
describe("timeline files",()=>{it("allows timeline and day-sheet documents with URLs",()=>{expect(isTimelineFile({filename:"wedding-timeline.pdf",mimeType:"application/pdf",url:"https://files.example/timeline"})).toBe(true);expect(isTimelineFile({name:"Job Day Sheet",mimeType:"image/png",url:"https://files.example/day-sheet"})).toBe(true)});it("does not expose arbitrary miscellaneous or executable files",()=>{expect(isTimelineFile({description:"Miscellaneous Files",filename:"contract.pdf",mimeType:"application/pdf",url:"https://files.example/contract"})).toBe(false);expect(isTimelineFile({filename:"timeline.exe",mimeType:"application/octet-stream",url:"https://files.example/timeline"})).toBe(false)})});
describe("plain operation status",()=>{it("uses clear success and error labels",()=>{expect(plainStatus("SUCCEEDED")).toMatchObject({tone:"good",icon:"✓",label:"Worked"});expect(plainStatus("FAILED")).toMatchObject({tone:"error",icon:"×",label:"Error"});expect(plainStatus("SUPPRESSED")).toMatchObject({tone:"neutral",label:"Safely skipped"})});it("makes unknown technical statuses readable",()=>expect(plainStatus("WAITING_FOR_REVIEW")).toMatchObject({tone:"neutral",label:"waiting for review"}))});
describe("quiet hours",()=>{it("detects night and moves to 8am",()=>{const night=new Date("2026-08-12T05:00:00Z");expect(outsideQuietHours(night,"America/Denver")).toBe(false);expect(nextAllowedTime(night,"America/Denver").toISOString()).toBe("2026-08-12T14:00:00.000Z")})});
describe("sequential reminders",()=>{it("advances after completed or administrator-skipped steps",()=>{expect(reminderStepIsSatisfied({status:"COMPLETED",lastError:null})).toBe(true);expect(reminderStepIsSatisfied({status:"CANCELED",lastError:"Skipped by administrator"})).toBe(true)});it("does not advance past waiting or failed steps",()=>{expect(reminderStepIsSatisfied({status:"CANCELED",lastError:"Waiting for previous reminder outcome"})).toBe(false);expect(reminderStepIsSatisfied({status:"FAILED",lastError:"Provider unavailable"})).toBe(false)})});
describe("branded email links",()=>{it("makes confirmation URLs clickable inside multi-assignment email bodies",()=>{const html=brandedEmailHtml({preheader:"Confirm",title:"Please confirm",body:"Assignment one: https://example.com/confirm/token-one\nAssignment two: https://example.com/confirm/token-two"});expect(html).toContain('<a href="https://example.com/confirm/token-one"');expect(html).toContain('<a href="https://example.com/confirm/token-two"')})});
describe("tokens and signatures",()=>{it("creates unique 256-bit opaque tokens and stores only their hashes",()=>{const x=createOpaqueToken(),y=createOpaqueToken();expect(x.token).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(x.token).not.toBe(y.token);expect(x.token).not.toBe(x.hash);expect(sha256(x.token)).toBe(x.hash)});it("verifies HMAC without timing leaks",()=>{const raw="payload",key="secret",sig=createHmac("sha256",key).update(raw).digest("hex");expect(verifyHmac(raw,sig,key)).toBe(true);expect(verifyHmac(raw,"bad",key)).toBe(false)});it("verifies Quo's structured base64 signature and rejects replays",()=>{const now=Date.now(),timestamp=String(now),raw='{\n  "id": "EV1", "type": "message.received"\n}',compact=JSON.stringify(JSON.parse(raw)),key=Buffer.from("quo-secret").toString("base64"),digest=createHmac("sha256",Buffer.from(key,"base64")).update(`${timestamp}.${compact}`).digest("base64"),header=`hmac;1;${timestamp};${digest}`;expect(verifyQuoWebhook(raw,header,key,now)).toBe(true);expect(verifyQuoWebhook(raw,"bad",key,now)).toBe(false);expect(verifyQuoWebhook(raw,header,key,now+6*60*1000)).toBe(false)})});

describe("request body limits", () => {
  it("reads a request within its byte limit", async () => {
    await expect(readLimitedText(new Request("https://example.test", { method: "POST", body: "safe" }), 4)).resolves.toBe("safe");
  });
  it("rejects a request over its byte limit", async () => {
    await expect(readLimitedText(new Request("https://example.test", { method: "POST", body: "too large" }), 4)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });
});

describe("operations agent result freshness", () => {
  const now = new Date("2026-08-10T23:00:00.000Z");

  it("does not keep a past event list on the Operations page", () => {
    expect(recentOperationsAgentResult({
      question: "Which weddings need attention?",
      answer: "Wedding Ceremony — 8/2/2026 — at risk",
      at: "2026-08-09T23:00:00.000Z",
    }, now)).toBeNull();
  });

  it("keeps a newly generated answer long enough to read", () => {
    expect(recentOperationsAgentResult({
      question: "Which weddings need attention?",
      answer: "Upcoming Wedding — 8/16/2026 — waiting for confirmation",
      at: "2026-08-10T22:50:00.000Z",
    }, now)?.answer).toContain("Upcoming Wedding");
  });
});
