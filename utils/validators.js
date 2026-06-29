const Joi = require('joi');

// Accept a phone with OR without the country code / formatting and normalize to
// the canonical 10 digits. The astrologer app sends 91-prefixed numbers (e.g.
// 917872358979) which the strict /^\d{10}$/ rule used to reject with "phone must
// be 10 digits" → the app showed "OTP didn't send". We strip non-digits, drop a
// leading 91 (12-digit) or 0 (11-digit), and require exactly 10 digits left.
const phone = Joi.string()
  .custom((value, helpers) => {
    let d = String(value).replace(/\D/g, ''); // drop +, spaces, dashes
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2); // 91XXXXXXXXXX
    else if (d.length === 11 && d.startsWith('0')) d = d.slice(1); // 0XXXXXXXXXX
    if (!/^\d{10}$/.test(d)) return helpers.error('any.invalid');
    return d; // normalized 10-digit value flows downstream (validate convert:true)
  })
  .message('phone must be 10 digits');
const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/).message('invalid id');

module.exports = {
  Joi,
  phone,
  objectId,

  // ── Auth ──
  requestOtp: Joi.object({ phone: phone.required() }),
  // Phone passed as a route param (e.g. astrologer exists-check).
  phoneParam: Joi.object({ phone: phone.required() }),
  verifyOtp: Joi.object({ phone: phone.required(), code: Joi.string().length(6).required() }),
  refresh: Joi.object({ refreshToken: Joi.string().required() }),
  fcmToken: Joi.object({
    token: Joi.string().required(),
    platform: Joi.string().valid('ios', 'android', 'web'),
    // Optional device identity (multi-device support + admin visibility).
    deviceId: Joi.string().max(128).allow(''),
    deviceName: Joi.string().max(120).allow(''),
    deviceModel: Joi.string().max(120).allow(''),
    osVersion: Joi.string().max(60).allow(''),
    appVersion: Joi.string().max(40).allow(''),
  }),
  updateProfile: Joi.object({
    name: Joi.string().max(100).allow(''),
    email: Joi.string().email().allow(''),
    avatar: Joi.string().allow(''),
    gender: Joi.string().valid('male', 'female', 'other'),
    language: Joi.string().valid('en', 'hi', 'bn', 'mr', 'pa', 'as'),
    profileCompleted: Joi.boolean(),
    location: Joi.object({
      lat: Joi.number().allow(null),
      lng: Joi.number().allow(null),
      city: Joi.string().allow(''),
      updatedAt: Joi.date(),
    }),
    permissions: Joi.object({
      notifications: Joi.boolean(),
      microphone: Joi.boolean(),
      camera: Joi.boolean(),
      photos: Joi.boolean(),
      location: Joi.boolean(),
    }),
    preferences: Joi.object({
      chartStyle: Joi.string().valid('north', 'south'),
      monthSystem: Joi.string().valid('amanta', 'purnimanta'),
      themeMode: Joi.string().valid('light', 'dark', 'system'),
      language: Joi.string().valid('en', 'hi', 'bn', 'mr', 'pa', 'as'),
      ayanamsa: Joi.string().valid('lahiri', 'kp_new', 'kp_old', 'raman', 'kp_khullar'),
    }),
    notificationSettings: Joi.object({
      frequency: Joi.string().valid('once_a_day', 'twice_a_day', 'all', 'never'),
      topics: Joi.array().items(Joi.string()).max(20),
    }),
    birthDetails: Joi.object({
      dob: Joi.date().allow(null),
      time: Joi.string().pattern(/^\d{2}:\d{2}$/).allow('', null),
      timeKnown: Joi.boolean(),
      place: Joi.string().allow(''),
      lat: Joi.number().allow(null),
      lng: Joi.number().allow(null),
      tz: Joi.number(),
    }),
  }),

  feedback: Joi.object({
    fullName: Joi.string().max(100).allow(''),
    email: Joi.string().email().allow(''),
    phone: Joi.string().max(20).allow(''),
    message: Joi.string().max(2000).required(),
  }),
  appRating: Joi.object({
    rating: Joi.number().integer().min(1).max(5).required(),
    review: Joi.string().max(1000).allow(''),
  }),

  // ── Sessions ──
  startSession: Joi.object({
    astrologerId: objectId.required(),
    type: Joi.string().valid('call', 'chat', 'video').required(),
  }),

  // ── Wallet / payments ──
  recharge: Joi.object({ amountRupees: Joi.number().integer().min(1).max(100000).required() }),

  // ── Reviews ──
  // Post-session feedback: astrologer rating (1-5) and/or call quality (1-5).
  // Each optional, but at least one required — a repeat session may submit only
  // callQuality (the astrologer was already reviewed in a prior session).
  review: Joi.object({
    rating: Joi.number().integer().min(1).max(5),
    comment: Joi.string().max(1000).allow(''),
    callQuality: Joi.number().integer().min(1).max(5),
  }).or('rating', 'callQuality'),
  adminReview: Joi.object({
    rating: Joi.number().integer().min(1).max(5).required(),
    comment: Joi.string().max(1000).allow(''),
    authorName: Joi.string().trim().max(80).allow(''),
    serviceType: Joi.string().valid('call', 'chat', 'video').allow('', null),
  }),

  // ── Astrologer signup (lead) ──
  astrologerSignup: Joi.object({
    name: Joi.string().max(100).required(),
    phone: phone.required(),
    email: Joi.string().email(),
    expertise: Joi.array().items(Joi.string()),
    languages: Joi.array().items(Joi.string()),
    experienceYears: Joi.number().min(0),
    note: Joi.string().max(1000),
    anonId: Joi.string().max(64).allow(''), // for visit attribution
    // Device push token captured at registration → approval push (optional).
    fcmToken: Joi.string().max(4096).allow(''),
  }),

  // Admin requests an OTP to verify an astrologer's phone (dev code 123456).
  adminAstrologerOtp: Joi.object({ phone: phone.required() }),

  // ── Admin: activate/update astrologer (rates in whole rupees/min) ──
  astrologerAdminUpdate: Joi.object({
    name: Joi.string().max(100), // for admin-create
    phone: phone, // for admin-create / phone change; becomes the astrologer's OTP login
    code: Joi.string().length(6), // OTP verifying `phone` (required when phone is set/changed)
    email: Joi.string().email().allow(''),
    displayName: Joi.string().max(100),
    avatar: Joi.string().allow(''), // hosted profile photo URL
    coverPhoto: Joi.string().allow(''), // hosted wide cover image URL
    bio: Joi.string().max(2000).allow(''),
    expertise: Joi.array().items(Joi.string()),
    languages: Joi.array().items(Joi.string()),
    experienceYears: Joi.number().min(0),
    // Admin-seeded display numbers (followers baseline + fake gifts shown on profile).
    followerSeed: Joi.number().integer().min(0),
    giftDisplay: Joi.object({
      count: Joi.number().integer().min(0),
      items: Joi.array().items(Joi.object({ name: Joi.string().max(60).allow(''), count: Joi.number().integer().min(0) })),
    }),
    applicationStatus: Joi.string().valid('applied', 'contacted', 'details_filled', 'active', 'rejected', 'suspended'),
    kycStatus: Joi.string().valid('pending', 'approved', 'rejected'),
    isFeatured: Joi.boolean(),
    acceptsFreeChat: Joi.boolean(),
    adminNote: Joi.string().max(2000),
    // Per-minute rates + admin cut are capped 0–100 ₹/min.
    rates: Joi.object({
      call: Joi.object({ enabled: Joi.boolean(), rateRupeesPerMin: Joi.number().integer().min(0).max(100), adminCutRupeesPerMin: Joi.number().integer().min(0).max(100) }),
      chat: Joi.object({ enabled: Joi.boolean(), rateRupeesPerMin: Joi.number().integer().min(0).max(100), adminCutRupeesPerMin: Joi.number().integer().min(0).max(100) }),
      video: Joi.object({ enabled: Joi.boolean(), rateRupeesPerMin: Joi.number().integer().min(0).max(100), adminCutRupeesPerMin: Joi.number().integer().min(0).max(100) }),
    }),
    payoutDetails: Joi.object({
      upi: Joi.string().allow(''),
      accountNumber: Joi.string().allow(''),
      ifsc: Joi.string().allow(''),
      beneficiaryName: Joi.string().allow(''),
    }),
    // KYC is fully optional — every field may be blank.
    kyc: Joi.object({
      aadhaarNumber: Joi.string().pattern(/^\d{12}$/).message('Aadhaar must be 12 digits').allow(''),
      panNumber: Joi.string().pattern(/^[A-Za-z]{5}\d{4}[A-Za-z]$/).message('Invalid PAN format').allow(''),
    }),
    kycDocuments: Joi.object({
      aadhaar: Joi.string().allow(''),
      pan: Joi.string().allow(''),
      bankPassbook: Joi.string().allow(''),
    }),
    location: Joi.object({
      address: Joi.string().allow(''),
      city: Joi.string().allow(''),
      state: Joi.string().allow(''),
      pincode: Joi.string().pattern(/^\d{6}$/).message('pincode must be 6 digits'),
      lat: Joi.number(),
      lng: Joi.number(),
    }),
  }),

  onlineToggle: Joi.object({ online: Joi.boolean().required() }),

  // Astrologer's payout (bank / UPI) details. Either a bank account (+IFSC) or
  // a UPI id is required — enforced more precisely in the controller.
  payoutDetails: Joi.object({
    accountNumber: Joi.string().trim().max(34).allow(''),
    ifsc: Joi.string().trim().max(15).allow(''),
    beneficiaryName: Joi.string().trim().max(120).allow(''),
    upi: Joi.string().trim().max(120).allow(''),
  }).or('accountNumber', 'upi'),

  // Astrologer self-edits their own profile (the editable subset only — rates,
  // commission, KYC and display name stay admin-controlled). `language` is the
  // UI language, saved on the User. At least one field required.
  astrologerSelfUpdate: Joi.object({
    bio: Joi.string().max(2000).allow(''),
    avatar: Joi.string().allow(''),
    coverPhoto: Joi.string().allow(''),
    expertise: Joi.array().items(Joi.string().max(60)),
    languages: Joi.array().items(Joi.string().max(60)),
    experienceYears: Joi.number().integer().min(0).max(80),
    language: Joi.string().valid('en', 'hi', 'bn', 'mr', 'pa', 'as'),
    // Marks onboarding done (first-time language + complete-profile flow). Once
    // true, the app skips those screens on subsequent logins.
    profileCompleted: Joi.boolean(),
  }).min(1),

  // ── Withdrawals ──
  withdrawal: Joi.object({
    amountRupees: Joi.number().integer().min(1).required(),
    bankAccountDetails: Joi.object({
      accountNumber: Joi.string(),
      ifsc: Joi.string(),
      name: Joi.string(),
      upi: Joi.string(),
    }).required(),
  }),

  // ── Commerce ──
  category: Joi.object({ name: Joi.string().required(), image: Joi.string().allow(''), isActive: Joi.boolean() }),
  product: Joi.object({
    name: Joi.string().required(),
    category: objectId.allow('', null),
    images: Joi.array().items(Joi.string()),
    description: Joi.string().allow(''),
    priceRupees: Joi.number().integer().min(0).required(),
    mrpRupees: Joi.number().integer().min(0),
    stock: Joi.number().integer().min(0),
    isActive: Joi.boolean(),
    // Admin-seeded social proof (shown until real activity passes the threshold).
    manualSoldCount: Joi.number().integer().min(0),
    manualRating: Joi.number().min(0).max(5),
    manualReviewCount: Joi.number().integer().min(0),
    highlights: Joi.array().items(Joi.string()),
  }),
  order: Joi.object({
    items: Joi.array().items(Joi.object({ productId: objectId.required(), qty: Joi.number().integer().min(1).required() })).min(1).required(),
    address: Joi.object({
      name: Joi.string().required(),
      phone: phone.required(),
      line1: Joi.string().required(),
      line2: Joi.string().allow(''),
      city: Joi.string().required(),
      state: Joi.string().required(),
      pincode: Joi.string().required(),
    }).required(),
  }),
  gift: Joi.object({ name: Joi.string().required(), image: Joi.string().allow(''), tokenCost: Joi.number().integer().min(1).required(), isActive: Joi.boolean() }),
  sendGift: Joi.object({ giftId: objectId.required(), receiverId: objectId.required(), sessionId: Joi.string().allow(''), liveSessionId: Joi.string().allow('') }),

  // ── Matrimony / Pooja ──
  matrimonyProfile: Joi.object({
    name: Joi.string(),
    gender: Joi.string().valid('male', 'female', 'other').required(),
    dob: Joi.date().required(),
    birthTime: Joi.string(),
    birthPlace: Joi.object({ place: Joi.string(), lat: Joi.number(), lng: Joi.number(), tz: Joi.number() }),
    maritalStatus: Joi.string().valid('never_married', 'divorced', 'widowed'),
    religion: Joi.string(),
    caste: Joi.string(),
    familyDetails: Joi.string(),
    partnerExpectations: Joi.string(),
    photos: Joi.array().items(Joi.string()),
  }),
  kundliMatch: Joi.object({ profile1: objectId.required(), profile2: objectId.required() }),
  poojaBooking: Joi.object({
    astrologerId: objectId,
    // New flow: book by pooja id (server resolves name + price). Legacy flow:
    // pass poojaType + priceRupees directly. Require one of the two.
    poojaTypeId: objectId,
    poojaType: Joi.string(),
    priceRupees: Joi.number().integer().min(0),
    contactName: Joi.string().allow(''),
    contactPhone: Joi.string().allow(''),
    familyMembers: Joi.array().items(Joi.string().max(120)).default([]),
    preferredDate: Joi.date(),
    specialInstructions: Joi.string().allow(''),
  }).or('poojaTypeId', 'poojaType'),

  // ── AI ──
  aiChat: Joi.object({ conversationId: objectId, message: Joi.string().max(2000).required() }),

  // ── Reviews ──
  platformReview: Joi.object({ rating: Joi.number().integer().min(1).max(5).required(), comment: Joi.string().max(2000).allow('') }),

  // ── Support ──
  supportTicket: Joi.object({
    category: Joi.string().valid('payment', 'call', 'account', 'kyc', 'payout', 'technical', 'other'),
    subject: Joi.string().max(200).required(),
    description: Joi.string().max(5000).required(),
    attachments: Joi.array().items(Joi.string()),
  }),
  supportReply: Joi.object({ message: Joi.string().max(5000).required() }),
  supportStatus: Joi.object({ status: Joi.string().valid('open', 'in_progress', 'resolved', 'closed').required() }),

  // ── Address book ──
  address: Joi.object({
    label: Joi.string().valid('home', 'work', 'other'),
    name: Joi.string(),
    phone: phone,
    line1: Joi.string().required(),
    line2: Joi.string().allow(''),
    city: Joi.string().required(),
    state: Joi.string().required(),
    pincode: Joi.string().required(),
    isDefault: Joi.boolean(),
  }),

  // ── Admin: manual recharge + admin management ──
  // Admin recharge is pack-only: pick a RechargeTemplate; the user is credited
  // the pack's `tokens` value. No free-form amount (anti fat-finger).
  adminRecharge: Joi.object({
    userId: objectId.required(),
    templateId: objectId.required(),
    reason: Joi.string().max(300).allow(''),
  }),
  adminUserOtp: Joi.object({ phone: phone.required() }),
  adminCreateUser: Joi.object({
    phone: phone.required(),
    code: Joi.string().length(6).required(),
    name: Joi.string().max(100).allow(''),
    email: Joi.string().email().allow(''),
  }),
  rechargeTemplate: Joi.object({
    amount: Joi.number().integer().min(1).max(1000000).required(),
    tokens: Joi.number().integer().min(1).max(1000000).required(),
    name: Joi.string().max(60).allow(''),
    badge: Joi.string().max(24).allow(''),
    benefits: Joi.array().items(Joi.string().max(120)).max(8),
    image: Joi.string().allow(''),
    isActive: Joi.boolean(),
    sortOrder: Joi.number().integer().min(0).max(9999),
  }),
  createAdmin: Joi.object({
    name: Joi.string().max(100).required(),
    phone: phone.required(),
    code: Joi.string().length(6).required(), // OTP verifying the phone (dev: 123456)
    email: Joi.string().email(),
    role: Joi.string().valid('admin', 'super_admin').required(),
  }),
  orderStatus: Joi.object({ status: Joi.string().valid('confirmed', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'refunded').required() }),

  // Order "Need help" request (raised from the order detail screen).
  orderSupport: Joi.object({
    category: Joi.string().valid('delivery', 'damaged', 'wrong_item', 'missing_item', 'payment', 'cancel', 'other'),
    message: Joi.string().max(2000).required(),
    contactPhone: Joi.string().max(20),
  }),
  orderSupportStatus: Joi.object({ status: Joi.string().valid('new', 'done').required() }),

  // ── Site content (admin) ──
  siteContent: Joi.object({
    title: Joi.string().allow(''),
    body: Joi.string().allow(''),
    data: Joi.object().unknown(true),
    isPublished: Joi.boolean(),
  }),

  // ── Order using a saved address id OR an inline address ──
  orderV2: Joi.object({
    items: Joi.array().items(Joi.object({ productId: objectId.required(), qty: Joi.number().integer().min(1).required() })).min(1).required(),
    addressId: objectId,
    address: Joi.object({
      name: Joi.string().required(),
      phone: phone.required(),
      line1: Joi.string().required(),
      line2: Joi.string().allow(''),
      city: Joi.string().required(),
      state: Joi.string().required(),
      pincode: Joi.string().required(),
    }),
  }).or('addressId', 'address'),

  // ── Contact-us / enquiry (public) ──
  enquiry: Joi.object({
    name: Joi.string().max(120).required(),
    email: Joi.string().email().allow(''),
    phone: Joi.string().max(20).allow(''),
    subject: Joi.string().max(200).allow(''),
    message: Joi.string().max(5000).required(),
    anonId: Joi.string().max(64).allow(''),
  }).or('email', 'phone'),

  // ── Admin: update an enquiry's status / note ──
  enquiryUpdate: Joi.object({
    status: Joi.string().valid('new', 'in_progress', 'resolved', 'spam'),
    adminNote: Joi.string().max(2000).allow(''),
  }).min(1),
};
