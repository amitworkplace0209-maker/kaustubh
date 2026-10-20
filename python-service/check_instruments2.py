import json

with open('C:/project/python-service/data/instrument_master.json') as f:
    data = json.load(f)

instruments = data['instruments']
print(f'Total instruments: {len(instruments)}')

# Find index instruments
indices = [i for i in instruments if i['symbol'] in ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY']]
print(f'\nIndex instruments: {len(indices)}')
for i in indices:
    print(f'  {i["symbol"]}: token={i["token"]}')

# Find equity stocks
equities = [i for i in instruments if i.get('series') == 'EQ']
print(f'\nEquity instruments: {len(equities)}')
# Show some popular ones
popular = [i for i in equities if i['symbol'] in ['WIPRO', 'IRCTC', 'ONGC', 'IFCI', 'CUPID', 'HIKAL', 'EIHOTEL', 'BOSCHLTD', 'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'AXISBANK', 'KOTAKBANK', 'BAJFINANCE', 'BAJAJFINSV', 'HINDUNILVR', 'ITC', 'LT', 'TATAMOTORS', 'MARUTI', 'SUNPHARMA', 'DRREDDY', 'CIPLA', 'DIVISLAB', 'M&M', 'BHARTIARTL', 'ADANIENT', 'ADANIPORTS', 'COALINDIA', 'NTPC', 'POWERGRID', 'BPCL', 'HINDALCO', 'VEDL', 'TATASTEEL', 'JSWSTEEL', 'ULTRACEMCO', 'GRASIM', 'SHREECEM', 'ASIANPAINT', 'KANSNER', 'TECHM', 'WIPRO']]
print(f'\nPopular equity stocks found: {len(popular)}')
for i in popular:
    print(f'  {i["symbol"]}: token={i["token"]}, tradingSymbol={i["tradingSymbol"]}')
