/**
 * Default legal copy seeded into every new tenant's DB at provision time.
 *
 * Both apps fetch these by key (GET /content/:key) and fall back to bundled
 * text only when the key is missing — so a tenant with nothing seeded silently
 * shows the generic in-app copy with the wrong brand name. Seeding gives each
 * tenant an editable, brand-correct starting point from day one; the tenant
 * admin can rewrite any of it afterwards (Content → Legal).
 *
 * Keys must match what the apps request:
 *   user app       → terms-user, privacy-user, refund-user
 *   astrologer app → terms-astrologer, privacy-astrologer
 *
 * NOTE: this is a reasonable industry-standard starting point for an astrology
 * consultation marketplace, NOT legal advice. Each operator should have counsel
 * review it before taking real payments.
 */

const P = (s) => `<p>${s}</p>`;
const H = (s) => `<h3>${s}</h3>`;
const UL = (items) => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;

/** Shared disclaimer — astrology is guidance, not professional advice. */
const disclaimer = (brand) =>
  H('Nature of the service') +
  P(`${brand} provides astrology, spiritual and wellness consultations for guidance and personal reflection only. Our services are not a substitute for professional medical, legal, financial or psychological advice. You must be 18 or older to use the platform.`);

function termsUser(brand) {
  return (
    P(`These terms govern your use of the ${brand} mobile application and related services (the "Services"). By creating an account you agree to them, together with our Privacy Policy and Refund Policy.`) +
    disclaimer(brand) +
    H('Your account') +
    UL([
      'You must be at least 18 years old and legally able to enter a contract.',
      'You register with a phone number verified by a one-time password (OTP). You are responsible for keeping that number and device secure.',
      'You agree to provide accurate information, including birth details where you choose to share them for a reading. You are responsible for all activity under your account.',
    ]) +
    H('Consultations and wallet') +
    UL([
      'Consultations (chat, audio call and video call) are billed per started minute at the rate shown on the astrologer\'s profile before you connect.',
      'You add money to your wallet in advance. A recharge pack may credit more than it charges; the credited amount is what is shown on the pack.',
      'Funds sufficient for your session are reserved when it begins. Anything unused is released back to your wallet when the session ends.',
      'A session ends automatically when your balance can no longer cover the next minute.',
      'Wallet balance is for use on the platform only. It is not transferable and cannot be withdrawn as cash.',
    ]) +
    H('Acceptable use') +
    UL([
      'Do not abuse, harass, threaten or discriminate against astrologers or other users.',
      'Do not share content that is unlawful, obscene, or infringes someone else\'s rights.',
      'Do not attempt to contact astrologers outside the platform, or to circumvent platform billing.',
      'We may suspend or terminate an account that breaches these terms.',
    ]) +
    H('Recordings and records') +
    P('Chat transcripts are retained for a limited period so you can review a past consultation. Audio and video sessions may be recorded for safety, quality and dispute resolution. See the Privacy Policy for how long data is kept and how it is used.') +
    H('Payments') +
    P('Payments are processed by third-party payment gateways. We do not store your full card details. A payment is credited to your wallet once the gateway confirms it as successful.') +
    H('Liability') +
    P(`To the extent permitted by law, ${brand} is not liable for decisions you take based on a consultation. Our total liability for any claim is limited to the amount you paid for the consultation giving rise to it.`) +
    H('Changes') +
    P('We may update these terms. Continued use of the Services after an update means you accept the revised terms.') +
    H('Contact') +
    P(`Questions about these terms? Reach us through the support option in the ${brand} app.`)
  );
}

function privacyUser(brand) {
  return (
    P(`This policy explains what ${brand} collects, why, and what control you have over it.`) +
    H('What we collect') +
    UL([
      'Account details: your phone number, and any name or email you provide.',
      'Birth details (date, time and place of birth) when you choose to share them for a reading.',
      'Consultation data: chat messages, and audio/video session metadata and recordings where applicable.',
      'Transaction data: wallet recharges, consultation charges and payment references.',
      'Device and usage data: device identifiers, app version, and notification tokens.',
    ]) +
    H('How we use it') +
    UL([
      'To deliver consultations and connect you with astrologers.',
      'To operate your wallet, process payments and prevent fraud.',
      'To send you notifications about your consultations and account.',
      'To improve the service, including quality review of consultations.',
    ]) +
    H('What astrologers can see') +
    P('Astrologers see an anonymous alias for each session, plus any birth details you chose to share. They do not see your phone number or real name.') +
    H('Sharing') +
    P('We share data with service providers who help us operate the platform (payment gateways, cloud hosting, communications and analytics providers), and where required by law. We do not sell your personal data.') +
    H('Retention') +
    P('Chat transcripts are retained for a limited period and then become unavailable in the app. Transaction records are kept as long as required for accounting and legal compliance.') +
    H('Your choices') +
    UL([
      'You can request deletion of your account and associated personal data.',
      'You can turn off notifications from your device settings.',
      'You can decline to share birth details, though some features will not work without them.',
    ]) +
    H('Security') +
    P('We use industry-standard measures to protect your data, including encryption in transit. No system is perfectly secure, so please keep your device and phone number secure.') +
    H('Contact') +
    P(`For any privacy request, contact us through the support option in the ${brand} app.`)
  );
}

function refundUser(brand) {
  return (
    P(`This policy explains when a ${brand} wallet recharge or consultation charge can be refunded.`) +
    H('Wallet recharges') +
    UL([
      'Wallet recharges are generally non-refundable once credited, because the balance is immediately usable across the platform.',
      'If money left your account but was not credited to your wallet, contact support with the payment reference. Confirmed failed payments are refunded to the original payment method.',
      'Duplicate charges for the same recharge are refunded in full.',
    ]) +
    H('Consultations') +
    UL([
      'Consultations are billed per started minute and are generally non-refundable once the session has run.',
      'If a session failed for technical reasons on our side (for example the astrologer never connected, or the call dropped immediately), the amount charged for it is credited back to your wallet.',
      'If an astrologer behaved inappropriately, report it through support. We review each report and may credit the consultation back.',
    ]) +
    H('How to request') +
    P('Raise a request through the support option in the app within 7 days of the transaction, including the date, amount and astrologer. We aim to respond within 3 business days.') +
    H('Processing time') +
    P('Wallet credits are applied as soon as a request is approved. Refunds to an original payment method are processed by the payment gateway and typically take 5-7 business days to appear.')
  );
}

function termsAstrologer(brand) {
  return (
    P(`These terms govern your work as an astrologer on ${brand}. By signing in you agree to them and to our Privacy Policy.`) +
    disclaimer(brand) +
    H('Your engagement') +
    UL([
      'You are an independent practitioner, not an employee of the platform.',
      'Your account is approved by the platform. You must provide accurate identity, qualification and payout details.',
      'You may not share, sell or transfer your account to anyone else.',
    ]) +
    H('Availability and consultations') +
    UL([
      'You control when you are online. While online you are expected to answer incoming requests promptly.',
      'Repeatedly missing or rejecting requests may reduce your visibility on the platform.',
      'Consultations are billed to the seeker per started minute at the rates configured for your profile.',
      'A session ends automatically when the seeker\'s balance runs out.',
    ]) +
    H('Earnings and payouts') +
    UL([
      'You earn the per-minute rate for your service less the platform commission shown in your profile.',
      'Earnings are credited to your platform wallet when a session completes.',
      'Payouts are made to your registered account according to the platform payout schedule.',
      'The platform may withhold earnings from sessions that are fraudulent, disputed or in breach of these terms.',
    ]) +
    H('Conduct') +
    UL([
      'Treat every seeker with respect and confidentiality.',
      'Do not request or accept payment outside the platform, and do not share personal contact details with seekers.',
      'Do not make medical, legal or financial guarantees, or promise specific outcomes.',
      'Do not use another person\'s content, credentials or identity.',
      'Serious or repeated breaches may result in suspension or removal.',
    ]) +
    H('Confidentiality') +
    P('Anything a seeker shares with you is confidential. Seekers appear to you under an anonymous alias; do not attempt to identify them or use their information outside the consultation.') +
    H('Recordings') +
    P('Sessions may be recorded for safety, quality and dispute resolution. By consulting on the platform you consent to this.') +
    H('Changes') +
    P('We may update these terms or the commission structure. Material changes will be notified in the app; continued use means you accept them.')
  );
}

function privacyAstrologer(brand) {
  return (
    P(`This policy explains what ${brand} collects about you as an astrologer on the platform.`) +
    H('What we collect') +
    UL([
      'Identity and contact details: name, phone number, email and any KYC documents you submit.',
      'Profile data: photo, biography, languages, areas of expertise and rates.',
      'Payout details needed to pay your earnings.',
      'Consultation data: chat messages, and audio/video session metadata and recordings where applicable.',
      'Performance data: sessions taken, response and rejection rates, ratings and reviews.',
      'Device and usage data: device identifiers, app version, and notification tokens.',
    ]) +
    H('How we use it') +
    UL([
      'To list your profile to seekers and route consultation requests to you.',
      'To calculate your earnings, commission and payouts.',
      'To monitor quality and safety, and to resolve disputes.',
      'To meet tax, accounting and other legal obligations.',
    ]) +
    H('What seekers can see') +
    P('Seekers see your public profile: display name, photo, biography, languages, expertise, ratings and rates. They do not see your phone number, KYC documents or payout details.') +
    H('Sharing') +
    P('We share data with service providers who help us operate the platform (payment and payout providers, cloud hosting, communications and analytics providers), and where required by law. We do not sell your personal data.') +
    H('Retention') +
    P('Profile and consultation records are retained while your account is active. Financial and KYC records are kept as long as required for tax and legal compliance, even after an account closes.') +
    H('Your choices') +
    UL([
      'You can update your profile and rates at any time from the app.',
      'You can request a copy of, or deletion of, your personal data, subject to records we must retain by law.',
    ]) +
    H('Contact') +
    P(`For any privacy request, contact the ${brand} platform team through the support option in the app.`)
  );
}

/**
 * Every default legal document for a tenant, ready to insert into SiteContent.
 * `brand` is the tenant's display name so the copy reads correctly per tenant.
 */
function defaultsFor(brand) {
  const b = brand || 'this platform';
  return [
    { key: 'terms-user', title: 'Terms of Service', body: termsUser(b) },
    { key: 'privacy-user', title: 'Privacy Policy', body: privacyUser(b) },
    { key: 'refund-user', title: 'Refund Policy', body: refundUser(b) },
    { key: 'terms-astrologer', title: 'Astrologer Terms of Service', body: termsAstrologer(b) },
    { key: 'privacy-astrologer', title: 'Astrologer Privacy Policy', body: privacyAstrologer(b) },
  ];
}

module.exports = { defaultsFor };
