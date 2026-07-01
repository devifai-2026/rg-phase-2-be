/* eslint-disable no-console */
require('dotenv').config();
const { connectDB, disconnectDB } = require('../config/db');
const User = require('../models/User');
const AstrologerProfile = require('../models/AstrologerProfile');
const Wallet = require('../models/Wallet');
const AdminSettings = require('../models/AdminSettings');
const Category = require('../models/Category');
const Product = require('../models/Product');
const Gift = require('../models/Gift');
const { toRupees } = require('../utils/money');

async function seed() {
  await connectDB();
  console.log('Seeding...');

  // Admin settings (singleton).
  await AdminSettings.get();

  // Super Admin (all access).
  const superAdmin = await User.findOneAndUpdate(
    { phone: '919999900000' },
    { $set: { name: 'Super Admin', role: 'super_admin', isPhoneVerified: true } },
    { upsert: true, new: true }
  );
  await Wallet.findOneAndUpdate({ user: superAdmin._id }, { $setOnInsert: { user: superAdmin._id } }, { upsert: true });
  console.log('  super_admin:', superAdmin.phone);

  // Operational Admin (limited access).
  const admin = await User.findOneAndUpdate(
    { phone: '919999911111' },
    { $set: { name: 'Ops Admin', role: 'admin', isPhoneVerified: true } },
    { upsert: true, new: true }
  );
  await Wallet.findOneAndUpdate({ user: admin._id }, { $setOnInsert: { user: admin._id } }, { upsert: true });
  console.log('  admin:', admin.phone);

  // Sample seeker with balance.
  const seeker = await User.findOneAndUpdate(
    { phone: '919888800000' },
    { $set: { name: 'Test Seeker', role: 'user', isPhoneVerified: true, birthDetails: { dob: new Date('1995-08-15'), time: '08:30', place: 'Mumbai', lat: 19.07, lng: 72.87, tz: 5.5 } } },
    { upsert: true, new: true }
  );
  await Wallet.findOneAndUpdate(
    { user: seeker._id },
    { $set: { balance: toRupees(1000) }, $setOnInsert: { user: seeker._id } },
    { upsert: true }
  );
  console.log('  seeker:', seeker.phone, '(₹1000 wallet)');

  // Sample ACTIVE astrologer with the exact example rates:
  //   call ₹10/min, admin cut ₹2/min -> astrologer ₹8/min.
  const astroUser = await User.findOneAndUpdate(
    { phone: '919777700000' },
    { $set: { name: 'Pandit Sharma', role: 'astrologer', isPhoneVerified: true } },
    { upsert: true, new: true }
  );
  await Wallet.findOneAndUpdate({ user: astroUser._id }, { $setOnInsert: { user: astroUser._id } }, { upsert: true });
  const profile = await AstrologerProfile.findOneAndUpdate(
    { user: astroUser._id },
    {
      $set: {
        displayName: 'Pandit Sharma',
        bio: 'Vedic astrologer, 15+ years.',
        expertise: ['Vedic', 'Numerology', 'Vastu'],
        languages: ['Hindi', 'English'],
        experienceYears: 15,
        applicationStatus: 'active',
        kycStatus: 'approved',
        activatedAt: new Date(),
        rates: {
          call: { enabled: true, ratePerMin: toRupees(10), adminCutPerMin: toRupees(2) },
          chat: { enabled: true, ratePerMin: toRupees(6), adminCutPerMin: toRupees(1) },
          video: { enabled: true, ratePerMin: toRupees(15), adminCutPerMin: toRupees(3) },
        },
        payoutDetails: { upi: 'panditsharma@upi', beneficiaryName: 'Pandit Sharma' },
      },
    },
    { upsert: true, new: true }
  );
  await User.updateOne({ _id: astroUser._id }, { $set: { astrologerProfile: profile._id } });
  console.log('  astrologer:', astroUser.phone, '(call ₹10/min, admin ₹2, astrologer ₹8)');

  // Categories + products.
  const cat = await Category.findOneAndUpdate({ name: 'Gemstones' }, { $set: { isActive: true } }, { upsert: true, new: true });
  await Category.findOneAndUpdate({ name: 'Rudraksha' }, { $set: { isActive: true } }, { upsert: true });
  await Category.findOneAndUpdate({ name: 'Yantras' }, { $set: { isActive: true } }, { upsert: true });
  await Product.findOneAndUpdate(
    { name: 'Natural Yellow Sapphire (Pukhraj)' },
    { $set: { category: cat._id, categoryName: cat.name, price: toRupees(5500), stock: 25, description: 'Certified 5.25 ratti.', isActive: true } },
    { upsert: true }
  );
  console.log('  categories + 1 product');

  // Gifts.
  await Gift.findOneAndUpdate({ name: 'Rose' }, { $set: { tokenCost: 10, isActive: true, emoji: '🌹' } }, { upsert: true });
  await Gift.findOneAndUpdate({ name: 'Diya' }, { $set: { tokenCost: 25, isActive: true, emoji: '🪔' } }, { upsert: true });
  await Gift.findOneAndUpdate({ name: 'Garland' }, { $set: { tokenCost: 50, isActive: true, emoji: '💐' } }, { upsert: true });
  console.log('  gifts');

  // Site content (Contact Us / About) the app displays.
  const SiteContent = require('../models/SiteContent');
  await SiteContent.findOneAndUpdate(
    { key: 'contact-us' },
    { $set: { title: 'Contact Us', body: 'We are here to help.', data: { email: 'support@rudraganga.com', phone: '+91-1800-000-000', address: 'Mumbai, India', hours: 'Mon–Sat 9am–9pm' }, isPublished: true } },
    { upsert: true }
  );
  await SiteContent.findOneAndUpdate(
    { key: 'about' },
    { $set: { title: 'About Us', body: 'Rudraganga — your trusted astrology & wellness companion.', isPublished: true } },
    { upsert: true }
  );
  console.log('  site content (contact-us, about)');

  console.log('Seed complete.');
  await disconnectDB();
  process.exit(0);
}

seed().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
