const mongoose = require('mongoose');
const { defineModel } = require('./registry');

const matrimonyProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String },
    gender: { type: String, enum: ['male', 'female', 'other'], required: true, index: true },
    dob: { type: Date, required: true },
    birthTime: { type: String }, // "HH:mm"
    birthPlace: {
      place: { type: String },
      lat: { type: Number },
      lng: { type: Number },
      tz: { type: Number, default: 5.5 },
    },
    maritalStatus: { type: String, enum: ['never_married', 'divorced', 'widowed'], default: 'never_married' },
    religion: { type: String },
    caste: { type: String },
    familyDetails: { type: String },
    partnerExpectations: { type: String },
    photos: [{ type: String }],
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

module.exports = defineModel('MatrimonyProfile', matrimonyProfileSchema);