'use strict';

const subscribers = new Set();

const STORAGE_KEYS = {
  searchQuery: 'queue-view:search-query',
  statusFilter: 'queue-view:status-filter',
};

let state = {
  searchQuery: localStorage.getItem(STORAGE_KEYS.searchQuery) || '',
  statusFilter: localStorage.getItem(STORAGE_KEYS.statusFilter) || 'all',
};

function notifySubscribers() {
  subscribers.forEach((listener) => listener(state));
}

function getQueueViewState() {
  return state;
}

function setQueueSearchQuery(searchQuery = '') {
  state = {
    ...state,
    searchQuery,
  };
  localStorage.setItem(STORAGE_KEYS.searchQuery, searchQuery);
  notifySubscribers();
}

function setQueueStatusFilter(statusFilter = 'all') {
  state = {
    ...state,
    statusFilter,
  };
  localStorage.setItem(STORAGE_KEYS.statusFilter, statusFilter);
  notifySubscribers();
}

function subscribeQueueViewState(listener) {
  subscribers.add(listener);
  listener(state);

  return () => {
    subscribers.delete(listener);
  };
}

export {
  getQueueViewState,
  setQueueSearchQuery,
  setQueueStatusFilter,
  subscribeQueueViewState,
};
