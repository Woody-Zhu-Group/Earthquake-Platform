import numpy as np
from tqdm import tqdm

class SyntheticSimulator:
    '''
    Synthetic simulator for spatio-temporal point process with change point and change region
    '''
    def __init__(self, mu0, mu1, beta, alpha,
                 S  = np.array([[0., 1.], [0., 1.]]),
                 center_post = np.array([[0.5, 0.5]]),
                 radius_post = 0.1,
                 nu = 0.5, T = np.array([0, 1])):
        '''
        Args:
        - S:        [ space_dim=2, 2 ] np, whole region 
        - S_post:   [ ncenter, space_dim=2, 2 ] np, change region
        - nu:       scalar, change point in temporal dimension
        - T:        [ 2 ] np, time window, e.g., [ 0, 1 ]
        '''
        self.mu0   = mu0
        self.mu1   = mu1
        self.beta  = beta
        self.alpha = alpha        
        self.S     = S      # [ space_dim, 2 ]
        self.center_post = center_post   # [ ncenter, space_dim ] np
        self.radius_post = radius_post   # scalar np
        self.nu    = nu
        self.T     = T      # [ 2 ]

    def simulate(self, lam_bar=None, verbose=True, restart=False):
        '''
        Args:
        - lam_bar:  scalar, dominating intensity for thinning
        - restart:   boolean, where
            True - restart thinning if lambda exceed lam_bar (may introduce bias, not recommended);
            False - raise error if lambda exceed lam_bar
        '''
        if lam_bar is None:
            lam_bar = max(self.mu0, self.mu1) + self.alpha * self.beta # default initialization
        pbar = tqdm(total=100, desc="Synthetic simulator") if verbose else None
        data_retained, lam_list = [], []
        while True:
            x_last = data_retained[-1] if len(data_retained) > 0 else np.zeros(len(self.S) + 1) # [ 3 ]
            # progress bar
            if verbose:
                perc = ((x_last[0] - self.T[0]) * 100 / np.diff(self.T)).astype(int).item()
                if perc - pbar.n >= 1:
                    pbar.update(perc - pbar.n)
                    pbar.refresh()
            # simulate points in the future regime
            X_ = np.concatenate([
                np.array([x_last[0], self.T[1]])[None, :],  # [ 1, 2 ]
                self.S      # [ nspace, 2 ]
            ], axis = 0)    # [ 3, 2 ] whole domain
            N = np.random.poisson(lam=lam_bar*np.diff(X_).prod())
            if N == 0:      # no points generated, end thinning
                break
            else:
                data_candidate = np.random.uniform(*X_.T, size=[N, len(self.S)+1])  # [ N, 3 ]
                data_candidate = data_candidate[data_candidate[:, 0].argsort()]         # [ N, 3 ]
                for x in data_candidate:
                    lam = self.lam(x, data_retained)    # scalar
                    lam_list.append(lam)
                    if lam > lam_bar:
                        if restart: # restart, but may introduce bias 
                            break
                        else:       # stop and raise error
                            raise KeyError('lambda exceed lam_bar!')
                    if np.random.uniform(0, 1) <= lam / lam_bar:    # accept
                        data_retained.append(x)
        print(f'lam_bar: {lam_bar}, observed max lam: {np.max(lam_list):.2f}') if verbose else None
        return np.array(data_retained)    # [ sample_size (=0), nspace + 1 ]
    
    def lam(self, x, data_retained):
        '''
        Args:
        - x: [ 3 ] np, a single data point
        - data_retained: [ nretained, 3 ] np, previously retained data points
        '''
        if len(data_retained) > 0:
            dx  = np.linalg.norm(x[None, :] - np.array(data_retained), ord=2, axis=1)   # [ nretained ] np
            lam = self.mu_(x) + self.alpha * self.beta * np.exp(-self.beta*dx).sum()    # scalar
        else:
            lam = self.mu_(x)
        return lam
                
    def mu_(self, x):
        '''
        x: [ 3 ] np, a single data point
        returns scalar
        '''
        dist_mat = np.linalg.norm(x[None, 1:] - self.center_post, ord=np.inf, axis=1)   # [ 1, ncenter ] np
        if np.any(dist_mat <= self.radius_post) and x[0] >= self.nu:    # in post-change regime
            return self.mu1
        else:
            return self.mu0

if __name__ == '__main__':
    beta    = 0.1
    scale   = 50
    mag     = 1

    # NOTE: np.array([]) for S_in and S_out if want only temporal data
    sim_kwds = {    
        'S':        np.array([[0., 1.], [0., 1.]]),
        'center_post': np.array([[0.5, 0.5]]),
        'radius_post': 0.1,
        'nu':       0.5,
        'T':        np.array([0., 1.]),
        'mu0':      1. * scale,
        'mu1':      10. * scale,
        'beta':     beta,
        'alpha':    mag / beta
    }

    sim = SyntheticSimulator(**sim_kwds)
    data = sim.simulate(verbose=True, restart=False, lam_bar=1000)   # [ nsample, 3 ]