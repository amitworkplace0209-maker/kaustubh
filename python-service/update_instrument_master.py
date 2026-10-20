import json

with open('C:/project/python-service/data/instrument_master.json') as f:
    data = json.load(f)

instruments = data['instruments']

# Index instruments that should use subscribe_index()
INDEX_SYMBOLS = {'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'}

# Popular stocks that should use L8 depth (subscribe_depth).
# With the L8 upgrade, EVERY equity trades at L8 depth by default; this set is
# kept as the documented historical depth universe (all members are still L8).
DEPTH_STOCKS = {
    'WIPRO', 'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN',
    'AXISBANK', 'KOTAKBANK', 'BAJFINANCE', 'BAJAJFINSV', 'HINDUNILVR', 'ITC',
    'LT', 'TATAMOTORS', 'MARUTI', 'SUNPHARMA', 'DRREDDY', 'CIPLA', 'DIVISLAB',
    'M&M', 'BHARTIARTL', 'ADANIENT', 'ADANIPORTS', 'COALINDIA', 'NTPC',
    'POWERGRID', 'BPCL', 'HINDALCO', 'VEDL', 'TATASTEEL', 'JSWSTEEL',
    'ULTRACEMCO', 'GRASIM', 'SHREECEM', 'ASIANPAINT', 'TECHM', 'HIKAL',
    'EIHOTEL', 'BOSCHLTD', 'IFCI', 'ONGC', 'CUPID', 'IRCTC'
}

updated = 0
for inst in instruments:
    symbol = inst['symbol']
    if symbol in INDEX_SYMBOLS:
        inst['isIndex'] = True
        inst['isDepth'] = False
        inst['feedLevel'] = None  # indices use subscribe_index
        inst['marketData'] = 'INDEX'
        updated += 1
    elif symbol in DEPTH_STOCKS:
        inst['isIndex'] = False
        inst['isDepth'] = True
        inst['feedLevel'] = 8
        inst['marketData'] = 'L8'
        updated += 1
    else:
        # DEFAULT for every equity: L8 depth (subscribe_depth). L4 touch-line
        # is NO LONGER the default feed.
        inst['isIndex'] = False
        inst['isDepth'] = True
        inst['feedLevel'] = 8
        inst['marketData'] = 'L8'

with open('C:/project/python-service/data/instrument_master.json', 'w') as f:
    json.dump(data, f, indent=2)

print(f'Updated {updated} instruments with feedLevel/isDepth/isIndex fields')
print(f'Total instruments: {len(instruments)}')
print(f'Indices (isIndex): {sum(1 for i in instruments if i.get("isIndex"))}')
print(f'Depth instruments (isDepth): {sum(1 for i in instruments if i.get("isDepth"))}')
print(f'L4 instruments: {sum(1 for i in instruments if i.get("feedLevel") == 4)}')
print(f'L8 instruments: {sum(1 for i in instruments if i.get("feedLevel") == 8)}')
