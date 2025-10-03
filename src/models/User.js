const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  userId: {
    type: Number,
    required: true,
    unique: true 
  },
  firstName: {
    type: String,
    trim: true,
    minlength: 2,
    maxlength: 50
  },
  lastName: {
    type: String,
    trim: true,
    minlength: 2,
    maxlength: 50
  },
  phone: {
    type: String,
    trim: true
  },
  email: {
    type: String,
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email format']
  },
  emailVerified: {
    type: Boolean,
    default: false
  },
  telegramId: {
    type: Number,
    sparse: true 
    
  }
}, {
  timestamps: true,
  collection: 'users'
});

userSchema.index({ emailVerified: 1 });
userSchema.index({ createdAt: -1 });

userSchema.virtual('fullName').get(function () {
  return `${this.firstName || ""} ${this.lastName || ""}`.trim();
});

userSchema.methods.isFullyRegistered = function () {
  return Boolean(
    this.emailVerified &&
    this.firstName &&
    this.lastName &&
    this.phone &&
    this.email
  );
};

userSchema.statics.findByTelegramId = function (telegramId) {
  return this.findOne({ userId: telegramId });
};

userSchema.statics.getVerifiedUsers = function () {
  return this.find({ emailVerified: true }).sort({ createdAt: -1 });
};

module.exports = mongoose.model('User', userSchema);
