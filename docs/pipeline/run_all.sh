set -e
cd /home/user/workspace
timeout 900 python3 work/flow2.py > /dev/null
python3 work/classify.py > /dev/null
python3 work/metrics.py > /dev/null
python3 work/rank.py > /dev/null
python3 work/score.py | tail -5
