type Recipient = {
  email: string;
  name?: string | null;
  params: Record<string, string>;
};

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function escapeHtml(value: string) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDateForEmail(value?: string) {
  if (!value) return "Check dashboard for deadline";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export async function sendDriveEmailsViaBrevo(args: {
  recipients: Recipient[];
  drive: {
    jobId: string;
    title: string;
    company: string;
    location?: string;
    jobType?: string;
    ctcOrStipend?: string;
    applyUrl?: string;
    deadlineIso?: string;
    instituteName?: string;
  };
}) {
  const apiKey = requireEnv("BREVO_API_KEY");
  const senderEmail = requireEnv("BREVO_SENDER_EMAIL");
  const senderName = process.env.BREVO_SENDER_NAME || "Tejaskrit TPO";

  const recipients = args.recipients.filter((r) => !!r.email.trim());
  if (!recipients.length) {
    return { sentCount: 0, batchCalls: 0 };
  }

  const htmlContent = `
<!doctype html>
<html>
  <body style="font-family:Arial,sans-serif;background:#f6f7fb;margin:0;padding:24px;">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:16px;padding:24px;border:1px solid #e5e7eb;">
      <div style="font-size:24px;font-weight:700;color:#2b36d9;margin-bottom:12px;">Tejaskrit TPO</div>
      <p style="font-size:16px;color:#111827;margin:0 0 12px;">Hello {{params.studentName}},</p>
      <p style="font-size:15px;color:#374151;line-height:1.6;">
        A new institute-verified drive has been posted for your profile.
      </p>

      <div style="margin:20px 0;padding:16px;border-radius:12px;background:#f9fafb;border:1px solid #e5e7eb;">
        <div style="font-size:18px;font-weight:700;color:#111827;">{{params.title}}</div>
        <div style="font-size:15px;color:#4b5563;margin-top:6px;">{{params.company}}</div>
        <div style="font-size:14px;color:#6b7280;margin-top:10px;">
          Location: {{params.location}}<br/>
          Type: {{params.jobType}}<br/>
          CTC / Stipend: {{params.ctcOrStipend}}<br/>
          Deadline: {{params.deadline}}
        </div>
      </div>

      <p style="font-size:14px;color:#374151;line-height:1.6;">
        Open the TPO/Candidate dashboard to view the full job description and apply.
      </p>

      {{params.applyBlock}}

      <p style="font-size:12px;color:#6b7280;margin-top:24px;">
        This notification was sent by {{params.instituteName}} through Tejaskrit.
      </p>
    </div>
  </body>
</html>`.trim();

  const subject = "{{params.company}} — {{params.title}} | New Institute Drive";

  const CHUNK = 1000;
  let sentCount = 0;
  let batchCalls = 0;

  for (let i = 0; i < recipients.length; i += CHUNK) {
    const slice = recipients.slice(i, i + CHUNK);

    const messageVersions = slice.map((r) => ({
      to: [{ email: r.email, name: r.name || undefined }],
      params: {
        studentName: escapeHtml(r.params.studentName || "Student"),
        title: escapeHtml(args.drive.title),
        company: escapeHtml(args.drive.company),
        location: escapeHtml(args.drive.location || "Not specified"),
        jobType: escapeHtml(args.drive.jobType || "Not specified"),
        ctcOrStipend: escapeHtml(args.drive.ctcOrStipend || "Not specified"),
        deadline: escapeHtml(formatDateForEmail(args.drive.deadlineIso)),
        instituteName: escapeHtml(args.drive.instituteName || "your institute"),
        applyBlock: args.drive.applyUrl
          ? `<p style="margin-top:18px;">
               <a href="${args.drive.applyUrl}" style="display:inline-block;background:#2b36d9;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:600;">
                 Open Apply Link
               </a>
             </p>`
          : "",
      },
    }));

    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify({
        sender: {
          email: senderEmail,
          name: senderName,
        },
        subject,
        htmlContent,
        messageVersions,
      }),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Brevo error ${res.status}: ${text || res.statusText}`);
    }

    sentCount += slice.length;
    batchCalls += 1;
  }

  return { sentCount, batchCalls };
}
