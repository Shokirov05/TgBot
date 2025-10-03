const mongoose = require('mongoose');

const pollOptionSchema = new mongoose.Schema({
  text: {
    type: String,
    required: true,
    trim: true,
    maxlength: 2000
  },
  votes: {
    type: Number,
    default: 0,
    min: 0
  }
}, { _id: false });

const pollSchema = new mongoose.Schema({
  question: {
    type: String,
    required: true,
    trim: true,
    minlength: 3,
    maxlength: 500
  },
  imageFileId: {          
    type: String,
    default: null
  },
  options: {
    type: [pollOptionSchema],
    required: true,
    validate: {
      validator: function(options) {
        return options.length >= 2 && options.length <= 50;
      },
      message: 'Poll must have between 2 and 50 options'
    }
  },
  createdBy: {
    type: Number,
    required: true,
    ref: 'User'
  },
  active: {
    type: Boolean,
    default: true,
    required: true
  },
  expiresAt: {
    type: Date,
    required: true
  },
  votes: {
    type: Map,
    of: Number,
    default: new Map()
  }
}, {
  timestamps: true,
  collection: 'polls'
});


pollSchema.index({ active: 1, expiresAt: 1 });
pollSchema.index({ createdBy: 1 });
pollSchema.index({ createdAt: -1 });

pollSchema.virtual('totalVotes').get(function() {
  return this.options.reduce((sum, option) => sum + option.votes, 0);
});

pollSchema.virtual('remainingTime').get(function() {
  if (!this.active) return 0;
  const now = new Date();
  const remaining = this.expiresAt - now;
  return Math.max(0, remaining);
});

pollSchema.virtual('remainingMinutes').get(function() {
  return Math.floor(this.remainingTime / (1000 * 60));
});

pollSchema.methods.isExpired = function() {
  return new Date() >= this.expiresAt;
};

pollSchema.methods.hasUserVoted = function(userId) {
  return this.votes && this.votes.has(userId.toString());
};

pollSchema.methods.getUserVote = function(userId) {
  return this.votes ? this.votes.get(userId.toString()) : undefined;
};

pollSchema.methods.addVote = function(userId, optionIndex) {
  if (this.hasUserVoted(userId)) {
    throw new Error('User has already voted');
  }
  
  if (optionIndex < 0 || optionIndex >= this.options.length) {
    throw new Error('Invalid option index');
  }
  
  if (!this.active || this.isExpired()) {
    throw new Error('Poll is not active or has expired');
  }
  
  this.options[optionIndex].votes += 1;
  
  if (!this.votes) {
    this.votes = new Map();
  }
  this.votes.set(userId.toString(), optionIndex);
  
  return this.save();
};

pollSchema.methods.getResultsSummary = function() {
  const total = this.totalVotes;
  
  return this.options.map((option, index) => ({
    index: index,
    text: option.text,
    votes: option.votes,
    percentage: total > 0 ? Math.round((option.votes / total) * 100) : 0
  }));
};

pollSchema.methods.formatResults = function() {
  const total = this.totalVotes;
  let result = `📊 ${this.active ? 'Oraliq' : 'Yakuniy'} natijalar:\n\n❓ ${this.question}\n\n`;
  
  this.options.forEach((option, index) => {
    const percentage = total > 0 ? Math.round((option.votes / total) * 100) : 0;
    result += `${index + 1}. ${option.text}: ${option.votes} ovoz (${percentage}%)\n`;
  });
  
  result += `\n👥 Jami ovoz: ${total}`;
  
  if (this.active) {
    const remaining = this.remainingMinutes;
    if (remaining > 0) {
      result += `\n⏰ Qolgan vaqt: ${remaining} daqiqa`;
    }
  }
  
  return result;
};

pollSchema.statics.findActivePolls = function() {
  return this.find({ 
    active: true, 
    expiresAt: { $gt: new Date() } 
  }).sort({ createdAt: -1 });
};

pollSchema.statics.findExpiredActivePolls = function() {
  return this.find({
    active: true,
    expiresAt: { $lt: new Date() }
  });
};

pollSchema.statics.findByCreator = function(creatorId) {
  return this.find({ createdBy: creatorId }).sort({ createdAt: -1 });
};

pollSchema.pre('save', function(next) {
  if (this.isNew && this.expiresAt <= new Date()) {
    return next(new Error('Expiry date must be in the future'));
  }
  next();
});

pollSchema.pre('save', function(next) {
  if (this.active && this.isExpired()) {
    this.active = false;
  }
  next();
});

module.exports = mongoose.model('Poll', pollSchema);