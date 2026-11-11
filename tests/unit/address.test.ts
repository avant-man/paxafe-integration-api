import { describe, expect, it } from 'vitest';
import { parseAddress } from '../../src/transform/address.js';

describe('parseAddress', () => {
  it('reproduces the PX example exactly', () => {
    expect(parseAddress('114 Hunts Point Market, Bronx, NY 10474, USA')).toEqual({
      street: null,
      locality: 'Bronx',
      state: 'NY',
      country: 'USA',
      postal_code: '10474',
      full_address: '114 Hunts Point Market, Bronx, NY 10474, USA',
    });
  });

  it('keeps a street when the first of 4+ parts looks like one', () => {
    expect(parseAddress('1460 E Hi Line Rd, Pharr, TX 78577, USA')).toMatchObject({
      street: '1460 E Hi Line Rd', locality: 'Pharr', state: 'TX', postal_code: '78577', country: 'USA',
    });
    expect(parseAddress('772 Edgewater Road, Bronx, NY 10474, USA')?.street).toBe('772 Edgewater Road');
    expect(parseAddress('10 Main St., Springfield, IL 62701, USA')?.street).toBe('10 Main St.');
  });

  it('does not treat a 3-part address as having a street', () => {
    expect(parseAddress('San Francisco, CA 94102, USA')).toMatchObject({
      street: null, locality: 'San Francisco', state: 'CA', postal_code: '94102', country: 'USA',
    });
  });

  it('accepts ZIP+4', () => {
    expect(parseAddress('Richmond, VA 23219-1234, USA')).toMatchObject({ state: 'VA', postal_code: '23219-1234' });
  });

  it('uses the second-last part as locality when there is no state and postal code', () => {
    expect(parseAddress('London, UK')).toEqual({
      street: null, locality: 'London', state: null, country: 'UK', postal_code: null, full_address: 'London, UK',
    });
  });

  it('handles a state part with no locality before it', () => {
    expect(parseAddress('CA 94102, USA')).toMatchObject({ locality: null, state: 'CA', postal_code: '94102', country: 'USA' });
  });

  it('handles a single part as country only', () => {
    expect(parseAddress('Japan')).toMatchObject({ country: 'Japan', locality: null });
  });

  it('trims parts and ignores empty ones', () => {
    expect(parseAddress('  Bronx ,  NY 10474 , USA ,')).toMatchObject({ locality: 'Bronx', state: 'NY', country: 'USA' });
  });

  it('returns null for missing, blank or non-string input', () => {
    expect(parseAddress(undefined)).toBeNull();
    expect(parseAddress(null)).toBeNull();
    expect(parseAddress('   ')).toBeNull();
    expect(parseAddress(42)).toBeNull();
  });

  it('reads state and ZIP from the last part when there is no country', () => {
    expect(parseAddress('Bronx, NY 10474')).toMatchObject({ locality: 'Bronx', state: 'NY', postal_code: '10474', country: null });
    expect(parseAddress('5 Main St, Bronx, NY 10474')).toMatchObject({ street: '5 Main St', locality: 'Bronx', country: null });
  });

  it('parses a Canadian province and postal code', () => {
    expect(parseAddress('Toronto, ON M5V 3L9, Canada')).toMatchObject({
      street: null, locality: 'Toronto', state: 'ON', postal_code: 'M5V 3L9', country: 'Canada',
    });
    expect(parseAddress('100 King St, Toronto, ON M5X1A9')).toMatchObject({
      street: '100 King St', locality: 'Toronto', state: 'ON', postal_code: 'M5X1A9', country: null,
    });
  });
});
